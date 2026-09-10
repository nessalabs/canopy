/**
 * SQLite adapter: a fork is a file copy, which is why SQLite is the cheapest isolation Canopy
 * offers — no engine, no port, no container, and `destroy` is an unlink.
 *
 * The "template" is simply the seed file committed in the repo (`source:`), so refreshing it is a
 * no-op: the next fork copies whatever the checkout currently has. WAL/SHM siblings are copied
 * with the file, because a database copied mid-WAL without them loses its most recent commits.
 */
import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import type { DatabaseSpec, DbSource } from '@canopy/shared'

import { ApiError } from '../../lib/errors'
import type { DbAdapter, DbContext, DbFork } from '../types'

/** Files that travel with a SQLite database. */
const SIDECARS = ['-wal', '-shm'] as const

const forkFile = (ctx: DbContext, name: string): string => join(ctx.dataDir, 'db', `${name}.db`)

const sizeMbOf = async (file: string): Promise<number | null> => {
  try {
    const info = await stat(file)
    return Math.round((info.size / 1024 / 1024) * 100) / 100
  } catch {
    return null
  }
}

const removeFile = async (file: string): Promise<void> => {
  await rm(file, { force: true })
  for (const suffix of SIDECARS) await rm(`${file}${suffix}`, { force: true })
}

const copyWithSidecars = async (from: string, to: string): Promise<void> => {
  await copyFile(from, to)
  for (const suffix of SIDECARS) await copyFile(`${from}${suffix}`, `${to}${suffix}`).catch(() => {})
}

const fail = (error: unknown): never => {
  throw new ApiError(500, 'db_sqlite_failed', error instanceof Error ? error.message : String(error))
}

export function createSqliteAdapter(): DbAdapter {
  return {
    adapter: 'sqlite',

    async available() {
      return { ok: true }
    },

    /** Nothing to build: the seed file in the checkout *is* the template. Only report what we see. */
    async ensureSource(name, spec: DatabaseSpec, ctx: DbContext) {
      if (!spec.source) {
        ctx.logs.sys(`sqlite ${name}: no source — forks start empty`)
        return
      }
      const source = resolve(ctx.projectPath, spec.source)
      const size = await sizeMbOf(source)
      if (size === null) ctx.logs.sys(`sqlite ${name}: source ${spec.source} not found — forks start empty`)
      else ctx.logs.sys(`sqlite ${name}: seed ${spec.source} (${size} MB)`)
    },

    async fork(name, spec: DatabaseSpec, ctx: DbContext, source: DbSource, sourceCtx?: DbContext): Promise<DbFork> {
      try {
        const target = forkFile(ctx, name)
        await mkdir(dirname(target), { recursive: true })
        await removeFile(target)

        let from: string | null = null
        if (typeof source === 'object') {
          if (!sourceCtx) throw new Error(`sqlite ${name}: no source worktree context for ${source.fromWorktree}`)
          from = forkFile(sourceCtx, name)
        } else if (source === 'template' && spec.source) {
          from = resolve(ctx.projectPath, spec.source)
        }

        const copied = from !== null && (await sizeMbOf(from)) !== null
        if (copied) {
          await copyWithSidecars(from as string, target)
          ctx.logs.sys(`sqlite ${name}: copied ${from}`)
        } else {
          await writeFile(target, '')
          ctx.logs.sys(`sqlite ${name}: created empty ${target}`)
        }
        return { url: `file:${target}`, sourceDatabase: copied ? from : null, detail: { file: target }, sizeMb: await sizeMbOf(target) }
      } catch (error) {
        return fail(error)
      }
    },

    async destroy(name, _spec: DatabaseSpec, ctx: DbContext) {
      await removeFile(forkFile(ctx, name)).catch(() => {})
    },

    async status(name, _spec: DatabaseSpec, ctx: DbContext) {
      const sizeMb = await sizeMbOf(forkFile(ctx, name))
      return { ready: sizeMb !== null, sizeMb }
    }
  }
}
