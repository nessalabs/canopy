/**
 * Postgres adapter: ONE container per engine version, one database per worktree.
 *
 * Running a server per worktree would cost a gigabyte of RAM for five branches and make cloning a
 * seeded database impossible; a single `canopy-pg-<version>` container instead lets every fork be
 * `CREATE DATABASE … TEMPLATE tpl_<project>_<db>`, which Postgres implements as a file-level copy —
 * a seeded 2 GB database forks in seconds and destroy is a DROP.
 *
 * The shared container needs a host port that survives daemon restarts and is not handed out by
 * the per-worktree allocator, so it is derived from the version (16 → 54316). Seed files are moved
 * with `docker cp` rather than piped through stdin: custom-format dumps are binary and would not
 * survive a round trip through a JS string.
 */
import { execa } from 'execa'
import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import type { DatabaseSpec, DbSource } from '@canopy/shared'

import { ApiError } from '../../lib/errors'
import { CANOPY_LABEL, CANOPY_NETWORK, DATABASE_LABEL, type DbAdapter, type DbContext, type DbFork, type DockerHelper } from '../types'
import { forkName, quoteIdentifier, quoteLiteral, templateName } from './naming'

const DEFAULT_VERSION = '16'
const PG_USER = 'canopy'
const PG_PASSWORD = 'canopy'
/** Restores and seed commands are slow by nature; the CLI must not time out under them. */
const SLOW_MS = 30 * 60_000
const READY_ATTEMPTS = 60

const versionOf = (spec: DatabaseSpec): string => (spec.version ?? DEFAULT_VERSION).replace(/[^a-zA-Z0-9._-]/g, '')

/** The shared container for one engine version. */
export const pgContainerName = (version: string): string => `canopy-pg-${version}`

/**
 * A stable host port per engine version (16 → 54316). Deterministic on purpose: the container
 * outlives the daemon, so the port has to be recomputable without any persisted state.
 */
export function pgFixedPort(version: string): number {
  const major = Number.parseInt(version, 10)
  if (Number.isFinite(major)) return 54300 + (major % 100)
  let hash = 0
  for (const char of version) hash = (hash * 31 + char.charCodeAt(0)) % 100
  return 54300 + hash
}

const unwrap = (info: Record<string, unknown> | null): Record<string, unknown> | null =>
  Array.isArray(info) ? ((info[0] as Record<string, unknown> | undefined) ?? null) : info

/** The host port `docker inspect` reports for 5432, so an existing container keeps its binding. */
function publishedPort(info: Record<string, unknown> | null): number | null {
  const record = unwrap(info)
  const settings = record?.['NetworkSettings'] as { Ports?: Record<string, Array<{ HostPort?: string }> | null> } | undefined
  const bindings = settings?.Ports?.['5432/tcp'] ?? (record?.['HostConfig'] as { PortBindings?: Record<string, Array<{ HostPort?: string }>> } | undefined)?.PortBindings?.['5432/tcp']
  const port = Number.parseInt(bindings?.[0]?.HostPort ?? '', 10)
  return Number.isFinite(port) ? port : null
}

const isRunning = (info: Record<string, unknown> | null): boolean => {
  const state = unwrap(info)?.['State'] as { Running?: unknown } | undefined
  return state?.Running === true
}

const fail = (error: unknown): never => {
  if (error instanceof ApiError) throw error
  throw new ApiError(500, 'db_postgres_failed', error instanceof Error ? error.message : String(error))
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/** `pg_dump -Fc` output starts with this magic; anything else we treat as plain SQL for psql. */
const isCustomDump = (head: Buffer): boolean => head.subarray(0, 5).toString('latin1') === 'PGDMP'

export function createPostgresAdapter(docker: DockerHelper): DbAdapter {
  /** In-flight `ensureContainer` per version: two worktrees provisioning at once must not both create it. */
  const starting = new Map<string, Promise<{ container: string; port: number }>>()

  const sql = async (container: string, database: string, statement: string, timeoutMs = 60_000): Promise<string> => {
    const result = await docker.run(['exec', container, 'psql', '-U', PG_USER, '-d', database, '-v', 'ON_ERROR_STOP=1', '-tAc', statement], { timeoutMs })
    return result.stdout.trim()
  }

  const databaseExists = async (container: string, name: string): Promise<boolean> =>
    (await sql(container, 'postgres', `SELECT 1 FROM pg_database WHERE datname = ${quoteLiteral(name)}`)) === '1'

  /** A database with open connections cannot be dropped or used as a TEMPLATE. */
  const terminate = async (container: string, name: string): Promise<void> => {
    await sql(container, 'postgres', `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${quoteLiteral(name)} AND pid <> pg_backend_pid()`).catch(() => '')
  }

  const dropDatabase = async (container: string, name: string): Promise<void> => {
    await terminate(container, name)
    await sql(container, 'postgres', `DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`, SLOW_MS)
  }

  const waitReady = async (container: string, ctx: DbContext): Promise<void> => {
    for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
      const probe = await docker.run(['exec', container, 'pg_isready', '-U', PG_USER], { okCodes: [0, 1, 2, 3, 125, 126] }).catch(() => null)
      if (probe?.exitCode === 0) return
      if (attempt === 4) ctx.logs.sys(`postgres: waiting for ${container} to accept connections…`)
      await sleep(1000)
    }
    throw new ApiError(500, 'db_postgres_failed', `${container} did not become ready`)
  }

  const ensureContainer = async (spec: DatabaseSpec, ctx: DbContext): Promise<{ container: string; port: number }> => {
    const version = versionOf(spec)
    const pending = starting.get(version)
    if (pending) return pending
    const task = (async () => {
      const container = pgContainerName(version)
      const existing = await docker.inspect(container).catch(() => null)
      if (existing) {
        if (!isRunning(existing)) {
          ctx.logs.sys(`postgres: starting ${container}`)
          await docker.run(['start', container])
        }
        const port = publishedPort(await docker.inspect(container)) ?? pgFixedPort(version)
        await waitReady(container, ctx)
        return { container, port }
      }
      const port = pgFixedPort(version)
      const image = `postgres:${version}`
      ctx.logs.sys(`postgres: creating ${container} (${image}) on port ${port}`)
      await docker.ensureNetwork(CANOPY_NETWORK)
      await docker.ensureImage(image, (text) => ctx.logs.sys(text))
      await docker.run([
        'run',
        '-d',
        '--name',
        container,
        '--label',
        `${CANOPY_LABEL}=true`,
        '--label',
        `${DATABASE_LABEL}=postgres`,
        '--network',
        CANOPY_NETWORK,
        '-e',
        `POSTGRES_USER=${PG_USER}`,
        '-e',
        `POSTGRES_PASSWORD=${PG_PASSWORD}`,
        '-e',
        'POSTGRES_DB=postgres',
        '-p',
        `${port}:5432`,
        // A named volume keeps templates (which are expensive to build) across daemon restarts.
        '-v',
        `${container}-data:/var/lib/postgresql/data`,
        image
      ])
      await waitReady(container, ctx)
      return { container, port }
    })()
    starting.set(version, task)
    try {
      return await task
    } catch (error) {
      starting.delete(version)
      return fail(error)
    }
  }

  const applyExtensions = async (container: string, database: string, spec: DatabaseSpec): Promise<void> => {
    const list = (spec.options['extensions'] ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
    for (const extension of list) await sql(container, database, `CREATE EXTENSION IF NOT EXISTS ${quoteIdentifier(extension)}`)
  }

  /** Copies a seed file into the container and replays it into `database`. */
  const loadFile = async (container: string, database: string, file: string, ctx: DbContext): Promise<void> => {
    const head = await readFile(file).then((buffer) => buffer.subarray(0, 8)).catch(() => {
      throw new ApiError(500, 'db_postgres_failed', `seed file not found: ${file}`)
    })
    const remote = `/tmp/canopy-seed-${basename(file).replace(/[^a-zA-Z0-9._-]/g, '_')}`
    await docker.run(['cp', file, `${container}:${remote}`], { timeoutMs: SLOW_MS })
    try {
      if (isCustomDump(head)) {
        ctx.logs.sys(`postgres: pg_restore ${basename(file)} → ${database}`)
        await docker.run(['exec', container, 'pg_restore', '-U', PG_USER, '-d', database, '--no-owner', '--no-privileges', remote], { timeoutMs: SLOW_MS, okCodes: [0, 1] })
      } else {
        ctx.logs.sys(`postgres: psql ${basename(file)} → ${database}`)
        await docker.run(['exec', container, 'psql', '-U', PG_USER, '-d', database, '-v', 'ON_ERROR_STOP=1', '-f', remote], { timeoutMs: SLOW_MS })
      }
    } finally {
      await docker.run(['exec', container, 'rm', '-f', remote], { okCodes: [0, 1] }).catch(() => {})
    }
  }

  // `postgresql://` rather than `postgres://`: SQLAlchemy 2 dropped the short alias; psql and libpq accept both.
  const urlFor = (port: number, database: string): string => `postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${port}/${database}`
  /** Connection parts for `${db.x.host}`-style templates (apps that need another driver scheme). */
  const detailFor = (container: string, port: number, database: string): Record<string, string> => ({ container, database, host: '127.0.0.1', port: String(port), user: PG_USER, password: PG_PASSWORD })

  return {
    adapter: 'postgres',

    async available() {
      const info = await docker.info()
      return info.available ? { ok: true } : { ok: false, reason: 'docker is not available' }
    },

    async ensureSource(name, spec: DatabaseSpec, ctx: DbContext, opts: { refresh: boolean }) {
      try {
        const { container, port } = await ensureContainer(spec, ctx)
        const template = templateName(ctx.projectName, name)
        const exists = await databaseExists(container, template)
        if (exists && !opts.refresh) return
        if (exists) {
          ctx.logs.sys(`postgres: rebuilding template ${template}`)
          await dropDatabase(container, template)
        }
        await sql(container, 'postgres', `CREATE DATABASE ${quoteIdentifier(template)}`, SLOW_MS)
        await applyExtensions(container, template, spec)

        const seed = spec.seed
        if (!seed) {
          ctx.logs.sys(`postgres: template ${template} created empty (no seed)`)
          return
        }
        if (seed.dump) await loadFile(container, template, resolve(ctx.projectPath, seed.dump), ctx)
        else if (seed.sql) await loadFile(container, template, resolve(ctx.projectPath, seed.sql), ctx)
        else if (seed.command) {
          const url = urlFor(port, template)
          const envKey = spec.env ?? `${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_URL`
          ctx.logs.sys(`postgres: seeding ${template} with \`${seed.command}\``)
          const result = await execa('/bin/sh', ['-c', seed.command], {
            cwd: ctx.projectPath,
            env: { ...process.env, ...ctx.env, DATABASE_URL: url, [envKey]: url },
            reject: false,
            all: true,
            timeout: SLOW_MS
          })
          for (const line of String(result.all ?? '').split('\n')) if (line.trim()) ctx.logs.out(line)
          if (result.exitCode !== 0) throw new ApiError(500, 'db_postgres_failed', `seed command exited ${result.exitCode}`)
        }
        ctx.logs.sys(`postgres: template ${template} ready`)
      } catch (error) {
        return fail(error)
      }
    },

    async fork(name, spec: DatabaseSpec, ctx: DbContext, source: DbSource, sourceCtx?: DbContext): Promise<DbFork> {
      try {
        const { container, port } = await ensureContainer(spec, ctx)
        const fork = forkName(ctx.worktreeId, name)
        await dropDatabase(container, fork)

        let template: string | null = null
        if (source === 'template') template = templateName(ctx.projectName, name)
        else if (typeof source === 'object') template = forkName(sourceCtx?.worktreeId ?? source.fromWorktree, name)

        if (template && !(await databaseExists(container, template))) {
          ctx.logs.sys(`postgres: ${template} does not exist — ${fork} starts empty`)
          template = null
        }
        if (template) {
          // TEMPLATE requires the source to be idle, so evict anything still connected to it.
          await terminate(container, template)
          await sql(container, 'postgres', `CREATE DATABASE ${quoteIdentifier(fork)} TEMPLATE ${quoteIdentifier(template)}`, SLOW_MS)
          ctx.logs.sys(`postgres: ${fork} forked from ${template}`)
        } else {
          await sql(container, 'postgres', `CREATE DATABASE ${quoteIdentifier(fork)}`, SLOW_MS)
          await applyExtensions(container, fork, spec)
          ctx.logs.sys(`postgres: ${fork} created empty`)
        }

        const size = await sql(container, 'postgres', `SELECT pg_database_size(${quoteLiteral(fork)})`).catch(() => '')
        const bytes = Number.parseInt(size, 10)
        return {
          url: urlFor(port, fork),
          sourceDatabase: template,
          detail: detailFor(container, port, fork),
          sizeMb: Number.isFinite(bytes) ? Math.round((bytes / 1024 / 1024) * 100) / 100 : null
        }
      } catch (error) {
        return fail(error)
      }
    },

    async destroy(name, spec: DatabaseSpec, ctx: DbContext) {
      // Teardown must always finish: a stopped engine simply means there is nothing to drop.
      try {
        const container = pgContainerName(versionOf(spec))
        if (!isRunning(await docker.inspect(container).catch(() => null))) return
        await dropDatabase(container, forkName(ctx.worktreeId, name))
      } catch (error) {
        ctx.logs.sys(`postgres: destroy ${name} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    async status(name, spec: DatabaseSpec, ctx: DbContext) {
      try {
        const container = pgContainerName(versionOf(spec))
        if (!isRunning(await docker.inspect(container).catch(() => null))) return { ready: false, sizeMb: null }
        const fork = forkName(ctx.worktreeId, name)
        const size = await sql(container, 'postgres', `SELECT pg_database_size(${quoteLiteral(fork)})`)
        const bytes = Number.parseInt(size, 10)
        if (!Number.isFinite(bytes)) return { ready: false, sizeMb: null }
        return { ready: true, sizeMb: Math.round((bytes / 1024 / 1024) * 100) / 100 }
      } catch {
        return { ready: false, sizeMb: null }
      }
    }
  }
}
