/**
 * MySQL adapter: one container per worktree, seeded from a plain-SQL template file.
 *
 * MySQL has no `CREATE DATABASE … TEMPLATE`, so the Postgres trick (fork a seeded database in
 * seconds) is not available. The next best thing is to pay the seeding cost once per project: the
 * template is materialised as a `.sql` file under the data root — copied straight from the repo's
 * dump/sql seed, or produced by running the project's seed command against a throwaway container
 * and `mysqldump`-ing the result — and each worktree's fresh container replays that one file.
 */
import { execa } from 'execa'
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { DatabaseSpec, DbSource } from '@canopy/shared'

import { ApiError } from '../../lib/errors'
import { CANOPY_LABEL, CANOPY_NETWORK, DATABASE_LABEL, SERVICE_LABEL, WORKTREE_LABEL, type DbAdapter, type DbContext, type DbFork, type DockerHelper } from '../types'
import { slug } from './naming'

const DEFAULT_VERSION = '8'
const ROOT_PASSWORD = 'canopy'
/** Every fork uses the same database name inside its own container; isolation is the container. */
const DATABASE = 'app'
const SLOW_MS = 30 * 60_000
const READY_ATTEMPTS = 90

const versionOf = (spec: DatabaseSpec): string => (spec.version ?? DEFAULT_VERSION).replace(/[^a-zA-Z0-9._-]/g, '')

export const mysqlContainerName = (worktreeId: string, name: string): string => `canopy-mysql-${slug(worktreeId.slice(0, 8), 8)}-${slug(name)}`

/** Where the project-wide seed file lives; shared by every worktree of the project. */
export const mysqlTemplateFile = (dataRoot: string, projectId: string, name: string): string => join(dataRoot, 'templates', projectId, `${name}.sql`)

const fail = (error: unknown): never => {
  if (error instanceof ApiError) throw error
  throw new ApiError(500, 'db_mysql_failed', error instanceof Error ? error.message : String(error))
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

const unwrap = (info: Record<string, unknown> | null): Record<string, unknown> | null =>
  Array.isArray(info) ? ((info[0] as Record<string, unknown> | undefined) ?? null) : info

/** The host port docker assigned to 3306 (used for `-p 0:3306` template containers). */
function publishedPort(info: Record<string, unknown> | null): number | null {
  const settings = unwrap(info)?.['NetworkSettings'] as { Ports?: Record<string, Array<{ HostPort?: string }> | null> } | undefined
  const port = Number.parseInt(settings?.Ports?.['3306/tcp']?.[0]?.HostPort ?? '', 10)
  return Number.isFinite(port) ? port : null
}

export function createMysqlAdapter(docker: DockerHelper, dataRoot: string): DbAdapter {
  const runArgs = (container: string, image: string, port: number | 0, labels: Record<string, string>): string[] => {
    const args = ['run', '-d', '--name', container, '--label', `${CANOPY_LABEL}=true`, '--label', `${DATABASE_LABEL}=mysql`]
    for (const [key, value] of Object.entries(labels)) args.push('--label', `${key}=${value}`)
    args.push('--network', CANOPY_NETWORK, '-e', `MYSQL_ROOT_PASSWORD=${ROOT_PASSWORD}`, '-e', `MYSQL_DATABASE=${DATABASE}`, '-p', `${port}:3306`, image)
    return args
  }

  const waitReady = async (container: string, ctx: DbContext): Promise<void> => {
    for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
      const probe = await docker
        .run(['exec', container, 'mysqladmin', 'ping', '-h127.0.0.1', `-p${ROOT_PASSWORD}`], { okCodes: [0, 1, 2, 125, 126] })
        .catch(() => null)
      if (probe?.exitCode === 0 && probe.stdout.includes('alive')) return
      if (attempt === 9) ctx.logs.sys(`mysql: waiting for ${container} to accept connections…`)
      await sleep(1000)
    }
    throw new ApiError(500, 'db_mysql_failed', `${container} did not become ready`)
  }

  /** Replays a `.sql` file inside the container; `docker cp` first so nothing large crosses stdin. */
  const loadSql = async (container: string, file: string, ctx: DbContext): Promise<void> => {
    const remote = '/tmp/canopy-seed.sql'
    await docker.run(['cp', file, `${container}:${remote}`], { timeoutMs: SLOW_MS })
    ctx.logs.sys(`mysql: loading ${file} into ${container}`)
    await docker.run(['exec', container, 'sh', '-c', `mysql -uroot -p${ROOT_PASSWORD} ${DATABASE} < ${remote}`], { timeoutMs: SLOW_MS })
    await docker.run(['exec', container, 'rm', '-f', remote], { okCodes: [0, 1] }).catch(() => {})
  }

  const dump = async (container: string): Promise<string> => {
    const result = await docker.run(['exec', container, 'mysqldump', '-uroot', `-p${ROOT_PASSWORD}`, '--no-tablespaces', DATABASE], { timeoutMs: SLOW_MS })
    return result.stdout
  }

  const sizeMb = async (container: string): Promise<number | null> => {
    const query = `SELECT IFNULL(ROUND(SUM(data_length + index_length) / 1024 / 1024, 2), 0) FROM information_schema.tables WHERE table_schema = '${DATABASE}'`
    const result = await docker.run(['exec', container, 'mysql', '-uroot', `-p${ROOT_PASSWORD}`, '-N', '-B', '-e', query], { okCodes: [0, 1] }).catch(() => null)
    const value = Number.parseFloat(result?.stdout.trim() ?? '')
    return Number.isFinite(value) ? value : null
  }

  return {
    adapter: 'mysql',

    async available() {
      const info = await docker.info()
      return info.available ? { ok: true } : { ok: false, reason: 'docker is not available' }
    },

    async ensureSource(name, spec: DatabaseSpec, ctx: DbContext, opts: { refresh: boolean }) {
      try {
        const target = mysqlTemplateFile(dataRoot, ctx.projectId, name)
        const seed = spec.seed
        if (!seed) {
          ctx.logs.sys(`mysql ${name}: no seed — forks start empty`)
          return
        }
        if (!opts.refresh && (await execa('/bin/sh', ['-c', `test -f ${JSON.stringify(target)}`], { reject: false })).exitCode === 0) return
        await mkdir(join(dataRoot, 'templates', ctx.projectId), { recursive: true })

        if (seed.dump || seed.sql) {
          const from = resolve(ctx.projectPath, (seed.dump ?? seed.sql) as string)
          await copyFile(from, target)
          ctx.logs.sys(`mysql ${name}: template from ${seed.dump ?? seed.sql}`)
          return
        }
        if (!seed.command) return

        // No file to copy: run the project's seeder against a throwaway server and dump the result.
        const container = `canopy-mysql-tpl-${slug(ctx.projectId.slice(0, 8), 8)}-${slug(name)}`
        const image = `mysql:${versionOf(spec)}`
        await docker.remove(container, { volumes: true }).catch(() => {})
        await docker.ensureNetwork(CANOPY_NETWORK)
        await docker.ensureImage(image, (text) => ctx.logs.sys(text))
        await docker.run(runArgs(container, image, 0, {}))
        try {
          await waitReady(container, ctx)
          const port = publishedPort(await docker.inspect(container))
          if (port === null) throw new ApiError(500, 'db_mysql_failed', `${container} published no port`)
          const url = `mysql://root:${ROOT_PASSWORD}@127.0.0.1:${port}/${DATABASE}`
          const envKey = spec.env ?? `${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_URL`
          ctx.logs.sys(`mysql ${name}: seeding template with \`${seed.command}\``)
          const result = await execa('/bin/sh', ['-c', seed.command], {
            cwd: ctx.projectPath,
            env: { ...process.env, ...ctx.env, DATABASE_URL: url, MYSQL_URL: url, [envKey]: url },
            reject: false,
            all: true,
            timeout: SLOW_MS
          })
          for (const line of String(result.all ?? '').split('\n')) if (line.trim()) ctx.logs.out(line)
          if (result.exitCode !== 0) throw new ApiError(500, 'db_mysql_failed', `seed command exited ${result.exitCode}`)
          await writeFile(target, await dump(container), 'utf8')
          ctx.logs.sys(`mysql ${name}: template written to ${target}`)
        } finally {
          await docker.remove(container, { volumes: true }).catch(() => {})
        }
      } catch (error) {
        return fail(error)
      }
    },

    async fork(name, spec: DatabaseSpec, ctx: DbContext, source: DbSource, sourceCtx?: DbContext): Promise<DbFork> {
      try {
        const port = await ctx.allocatePort(`db:${name}`)
        const container = mysqlContainerName(ctx.worktreeId, name)
        const image = `mysql:${versionOf(spec)}`
        await docker.remove(container, { volumes: true }).catch(() => {})
        await docker.ensureNetwork(CANOPY_NETWORK)
        await docker.ensureImage(image, (text) => ctx.logs.sys(text))
        ctx.logs.sys(`mysql: starting ${container} (${image}) on port ${port}`)
        await docker.run(runArgs(container, image, port, { [WORKTREE_LABEL]: ctx.worktreeId, [SERVICE_LABEL]: name }))
        await waitReady(container, ctx)

        let sourceDatabase: string | null = null
        if (typeof source === 'object') {
          if (!sourceCtx) throw new ApiError(500, 'db_mysql_failed', `mysql ${name}: no source worktree context for ${source.fromWorktree}`)
          const temp = join(ctx.dataDir, `mysql-${name}-from-${slug(sourceCtx.worktreeId.slice(0, 8), 8)}.sql`)
          await mkdir(ctx.dataDir, { recursive: true })
          await writeFile(temp, await dump(mysqlContainerName(sourceCtx.worktreeId, name)), 'utf8')
          await loadSql(container, temp, ctx)
          await rm(temp, { force: true })
          sourceDatabase = `${mysqlContainerName(sourceCtx.worktreeId, name)}/${DATABASE}`
        } else if (source === 'template') {
          const template = mysqlTemplateFile(dataRoot, ctx.projectId, name)
          if ((await execa('/bin/sh', ['-c', `test -f ${JSON.stringify(template)}`], { reject: false })).exitCode === 0) {
            await loadSql(container, template, ctx)
            sourceDatabase = template
          } else ctx.logs.sys(`mysql ${name}: no template — starting empty`)
        }

        return {
          url: `mysql://root:${ROOT_PASSWORD}@127.0.0.1:${port}/${DATABASE}`,
          sourceDatabase,
          detail: { container, port: String(port), database: DATABASE },
          sizeMb: await sizeMb(container)
        }
      } catch (error) {
        return fail(error)
      }
    },

    async destroy(name, _spec: DatabaseSpec, ctx: DbContext) {
      // Volumes go too: the container is this worktree's data, and the worktree is going away.
      await docker.remove(mysqlContainerName(ctx.worktreeId, name), { volumes: true }).catch((error: unknown) => {
        ctx.logs.sys(`mysql: destroy ${name} failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    },

    async status(name, _spec: DatabaseSpec, ctx: DbContext) {
      const container = mysqlContainerName(ctx.worktreeId, name)
      const probe = await docker.run(['exec', container, 'mysqladmin', 'ping', '-h127.0.0.1', `-p${ROOT_PASSWORD}`], { okCodes: [0, 1, 2, 125, 126] }).catch(() => null)
      if (probe?.exitCode !== 0) return { ready: false, sizeMb: null }
      return { ready: true, sizeMb: await sizeMb(container) }
    }
  }
}
