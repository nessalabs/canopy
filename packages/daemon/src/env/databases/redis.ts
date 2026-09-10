/**
 * Redis adapter: one small server per worktree, because Redis has no cheap "fork a database"
 * primitive — `SELECT n` numbered databases share memory, eviction and FLUSHALL, so two worktrees
 * on one server are not isolated in any way that matters. A container (or a host `redis-server`
 * when the developer has one installed and asks for it) costs a few megabytes and gives real
 * isolation, its own port and an appendonly directory that can simply be copied from another
 * worktree to clone its state.
 */
import { execa } from 'execa'
import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { DatabaseSpec, DbSource } from '@canopy/shared'

import { ApiError } from '../../lib/errors'
import { CANOPY_LABEL, CANOPY_NETWORK, DATABASE_LABEL, SERVICE_LABEL, WORKTREE_LABEL, type DbAdapter, type DbContext, type DbFork, type DockerHelper } from '../types'
import { slug } from './naming'

const DEFAULT_VERSION = '7'

/** Per-worktree container name; the worktree id prefix is what makes it unique. */
export const redisContainerName = (worktreeId: string, name: string): string => `canopy-redis-${slug(worktreeId.slice(0, 8), 8)}-${slug(name)}`

const dataDirFor = (ctx: DbContext, name: string): string => join(ctx.dataDir, 'redis', name)
const pidFileFor = (ctx: DbContext, name: string): string => join(ctx.dataDir, 'redis', `${name}.pid`)

const fail = (error: unknown): never => {
  if (error instanceof ApiError) throw error
  throw new ApiError(500, 'db_redis_failed', error instanceof Error ? error.message : String(error))
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/** `redis-server` on PATH — only then can `runtime: host` be honoured. */
async function hostRedisAvailable(): Promise<boolean> {
  const result = await execa('/bin/sh', ['-c', 'command -v redis-server'], { reject: false })
  return result.exitCode === 0
}

const readPid = async (file: string): Promise<number | null> => {
  const text = await readFile(file, 'utf8').catch(() => '')
  const pid = Number.parseInt(text.trim(), 10)
  return Number.isFinite(pid) && pid > 0 ? pid : null
}

const killPid = (pid: number): void => {
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
}

export function createRedisAdapter(docker: DockerHelper): DbAdapter {
  const wantsHost = (spec: DatabaseSpec): boolean => spec.runtime === 'host'

  /** Removes whatever is currently serving this database, whichever runtime it used. */
  const teardown = async (name: string, ctx: DbContext): Promise<void> => {
    await docker.remove(redisContainerName(ctx.worktreeId, name), { volumes: true }).catch(() => {})
    const pid = await readPid(pidFileFor(ctx, name))
    if (pid !== null) killPid(pid)
    await rm(pidFileFor(ctx, name), { force: true })
  }

  const startContainer = async (name: string, spec: DatabaseSpec, ctx: DbContext, port: number, dir: string): Promise<string> => {
    const container = redisContainerName(ctx.worktreeId, name)
    const image = `redis:${(spec.version ?? DEFAULT_VERSION).replace(/[^a-zA-Z0-9._-]/g, '')}`
    await docker.ensureNetwork(CANOPY_NETWORK)
    await docker.ensureImage(image, (text) => ctx.logs.sys(text))
    ctx.logs.sys(`redis: starting ${container} (${image}) on port ${port}`)
    await docker.run([
      'run',
      '-d',
      '--name',
      container,
      '--label',
      `${CANOPY_LABEL}=true`,
      '--label',
      `${DATABASE_LABEL}=redis`,
      '--label',
      `${WORKTREE_LABEL}=${ctx.worktreeId}`,
      '--label',
      `${SERVICE_LABEL}=${name}`,
      '--network',
      CANOPY_NETWORK,
      '-p',
      `${port}:6379`,
      '-v',
      `${dir}:/data`,
      image,
      'redis-server',
      '--appendonly',
      'yes',
      '--dir',
      '/data'
    ])
    return container
  }

  const startHost = async (name: string, ctx: DbContext, port: number, dir: string): Promise<number> => {
    const child = spawn('redis-server', ['--port', String(port), '--dir', dir, '--appendonly', 'yes', '--daemonize', 'no'], { detached: true, stdio: 'ignore' })
    child.unref()
    const pid = child.pid
    if (pid === undefined) throw new ApiError(500, 'db_redis_failed', `could not spawn redis-server for ${name}`)
    await writeFile(pidFileFor(ctx, name), String(pid), 'utf8')
    ctx.logs.sys(`redis: host redis-server pid ${pid} on port ${port}`)
    return pid
  }

  /** `redis-cli ping` through the container or on the host, whichever is serving. */
  const ping = async (name: string, spec: DatabaseSpec, ctx: DbContext, port: number | null): Promise<boolean> => {
    if (!wantsHost(spec)) {
      const result = await docker.run(['exec', redisContainerName(ctx.worktreeId, name), 'redis-cli', 'ping'], { okCodes: [0, 1] }).catch(() => null)
      return result?.stdout.trim().toUpperCase() === 'PONG'
    }
    if (port === null) return false
    const result = await execa('redis-cli', ['-p', String(port), 'ping'], { reject: false }).catch(() => null)
    return String(result?.stdout ?? '').trim().toUpperCase() === 'PONG'
  }

  return {
    adapter: 'redis',

    async available() {
      if (await hostRedisAvailable()) return { ok: true }
      const info = await docker.info()
      return info.available ? { ok: true } : { ok: false, reason: 'neither redis-server nor docker is available' }
    },

    /** Redis has no shared template: every fork is a fresh server (optionally seeded by a copy). */
    async ensureSource(name, _spec: DatabaseSpec, ctx: DbContext) {
      ctx.logs.sys(`redis ${name}: no template needed`)
    },

    async fork(name, spec: DatabaseSpec, ctx: DbContext, source: DbSource, sourceCtx?: DbContext): Promise<DbFork> {
      try {
        const port = await ctx.allocatePort(`db:${name}`)
        const dir = dataDirFor(ctx, name)
        await teardown(name, ctx)
        await rm(dir, { recursive: true, force: true })
        await mkdir(dir, { recursive: true })

        let sourceDatabase: string | null = null
        if (typeof source === 'object') {
          if (!sourceCtx) throw new ApiError(500, 'db_redis_failed', `redis ${name}: no source worktree context for ${source.fromWorktree}`)
          // Copy the appendonly/RDB files before the server starts: Redis loads them at boot.
          await cp(dataDirFor(sourceCtx, name), dir, { recursive: true }).catch(() => {})
          sourceDatabase = dataDirFor(sourceCtx, name)
          ctx.logs.sys(`redis ${name}: copied data from worktree ${sourceCtx.worktreeName}`)
        }

        const host = wantsHost(spec) && (await hostRedisAvailable())
        if (wantsHost(spec) && !host) ctx.logs.sys(`redis ${name}: redis-server not on PATH — falling back to docker`)
        const detail: Record<string, string> = { port: String(port) }
        if (host) detail['pid'] = String(await startHost(name, ctx, port, dir))
        else detail['container'] = await startContainer(name, { ...spec, runtime: 'docker' }, ctx, port, dir)

        for (let attempt = 0; attempt < 30; attempt += 1) {
          if (await ping(name, host ? spec : { ...spec, runtime: 'docker' }, ctx, port)) break
          await sleep(500)
        }
        return { url: `redis://127.0.0.1:${port}/0`, sourceDatabase, detail, sizeMb: null }
      } catch (error) {
        return fail(error)
      }
    },

    async destroy(name, _spec: DatabaseSpec, ctx: DbContext) {
      try {
        await teardown(name, ctx)
        await rm(dataDirFor(ctx, name), { recursive: true, force: true })
      } catch (error) {
        ctx.logs.sys(`redis: destroy ${name} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    async status(name, spec: DatabaseSpec, ctx: DbContext) {
      try {
        const pid = await readPid(pidFileFor(ctx, name))
        const port = pid === null ? null : await ctx.allocatePort(`db:${name}`)
        const ready = await ping(name, spec, ctx, port)
        // Redis size lives in RSS, not on disk; the resource sampler reports memory instead.
        return { ready, sizeMb: null }
      } catch {
        return { ready: false, sizeMb: null }
      }
    }
  }
}
