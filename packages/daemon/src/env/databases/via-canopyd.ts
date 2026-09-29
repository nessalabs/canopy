/**
 * Database forks through `canopyd db`, with the in-process adapter behind it.
 *
 * canopyd makes the fork when it can: it records it with the worktree's other state and — the
 * part that matters — then resolves `${db.main.url}` itself, so a worktree whose services refer
 * to a fork can be supervised by `canopyd run`. It cannot when the worktree is on a detached
 * HEAD (canopyd addresses worktrees by branch), when the binary is missing or too old for this
 * engine, when the project has the tool turned off, when the database asks for something only
 * this daemon does (a Redis on `runtime: host`: canopyd's is always a container), or when the
 * `canopy.yaml` this daemon resolved is one canopyd does not see (the project-home copy) and so
 * it has never heard of the database. Every one of those falls back to what this daemon has
 * always done.
 *
 * For Postgres the two agree on names — the server, its port, its templates — so which of them
 * made a template does not matter to the other. For MySQL and Redis they deliberately do not: a
 * fork is a container of its own, named after the worktree's id here and after its state
 * directory there, so clearing this daemon's stale fork can never take canopyd's new one with it.
 * `destroy` and `status` ask both, because a worktree may hold a fork from before canopyd made
 * them: removing a fork must remove it wherever it is.
 */
import type { DatabaseSpec, DbSource } from '@canopy/shared'

import { atLeast, type Canopyd, type CanopydFork } from '../worktree/canopyd'
import type { DbAdapter, DbContext, DbFork } from '../types'

/** Marks a fork canopyd made, so the supervisor choice can tell `${db.…}` will resolve there. */
export const MANAGED_BY = 'managed_by'

/** The canopyd release that first drove each engine. */
const SINCE: Record<DbAdapter['adapter'], [number, number]> = { sqlite: [0, 3], postgres: [0, 5], mysql: [0, 6], redis: [0, 6] }

/** What canopyd would make differently from what the database asks for stays with this daemon. */
const onlyHere = (spec: DatabaseSpec): boolean => spec.adapter === 'redis' && spec.runtime === 'host'

export interface ViaCanopydDeps {
  canopyd: Canopyd
  /** The in-process adapter for the same engine: the fallback, and the engine's name. */
  native: DbAdapter
  /** The project's "use canopyd" setting. */
  enabled: (projectId: string) => boolean
}

const mb = (bytes: number | undefined): number | null => (bytes === undefined ? null : Math.round((bytes / 1024 / 1024) * 100) / 100)

/** Errors that mean "canopyd is not looking at this database", as opposed to "the fork failed". */
const notCanopyds = (error: unknown): boolean => {
  const code = (error as { code?: string } | null)?.code
  return code === 'config_invalid' || code === 'config_not_found' || code === 'worktree_not_found' || code === 'not_a_repository'
}

export function createViaCanopyd(deps: ViaCanopydDeps): DbAdapter {
  const engine = deps.native.adapter
  const since = SINCE[engine]
  const usable = async (spec: DatabaseSpec, ctx: DbContext): Promise<string | null> => {
    if (onlyHere(spec) || !ctx.worktreeBranch || !deps.enabled(ctx.projectId)) return null
    return atLeast(await deps.canopyd.version(), since[0], since[1]) ? ctx.worktreeBranch : null
  }

  const from = (source: DbSource, sourceCtx?: DbContext): string | null => {
    if (typeof source !== 'object') return source
    // canopyd copies another worktree's fork by that worktree's branch.
    return sourceCtx?.worktreeBranch ?? null
  }

  const toFork = (fork: CanopydFork): DbFork => ({
    url: fork.url,
    sourceDatabase: fork.source ?? null,
    detail: { ...fork.detail, [MANAGED_BY]: 'canopyd' },
    sizeMb: mb(fork.size_bytes)
  })

  return {
    adapter: engine,
    available: () => deps.native.available(),

    /**
     * canopyd builds a missing template as part of the fork, so there is nothing to do ahead of
     * it. A *rebuild* is asked for at project level, where there is no worktree for canopyd to
     * address; the in-process adapter does it, against the template both of them use.
     */
    async ensureSource(name, spec, ctx, opts) {
      if (!opts.refresh && (await usable(spec, ctx))) return
      await deps.native.ensureSource(name, spec, ctx, opts)
    },

    async fork(name, spec: DatabaseSpec, ctx: DbContext, source: DbSource, sourceCtx?: DbContext): Promise<DbFork> {
      const branch = await usable(spec, ctx)
      const origin = from(source, sourceCtx)
      if (branch && origin) {
        try {
          // `reset`, not `fork`: this adapter's contract is a fresh fork, and canopyd's `fork`
          // deliberately leaves an existing one alone.
          const fork = await deps.canopyd.dbReset({ cwd: ctx.worktreePath, branch, name, from: origin })
          // One fork, in one place: whatever the in-process adapter held before is stale now.
          await deps.native.destroy(name, spec, ctx).catch(() => undefined)
          ctx.logs.sys(`${engine} ${name}: forked by canopyd from ${fork.forked_from}${fork.source ? ` (${fork.source})` : ''}`)
          return toFork(fork)
        } catch (error) {
          if (!notCanopyds(error)) throw error
          ctx.logs.sys(`${engine} ${name}: canopyd does not see this database — forking it here`)
        }
      }
      return deps.native.fork(name, spec, ctx, source, sourceCtx)
    },

    async destroy(name, spec, ctx) {
      const branch = await usable(spec, ctx)
      if (branch) await deps.canopyd.dbDrop({ cwd: ctx.worktreePath, branch, name }).catch(() => false)
      await deps.native.destroy(name, spec, ctx)
    },

    async status(name, spec, ctx) {
      const branch = await usable(spec, ctx)
      if (branch) {
        const forks = await deps.canopyd.dbList({ cwd: ctx.worktreePath, branch }).catch(() => [])
        const fork = forks.find((candidate) => candidate.name === name)
        if (fork) return { ready: fork.status === 'ready', sizeMb: mb(fork.size_bytes) }
      }
      return deps.native.status(name, spec, ctx)
    }
  }
}
