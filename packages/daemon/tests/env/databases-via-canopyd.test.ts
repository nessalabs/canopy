/**
 * The adapter that sends database forks to canopyd, against a fake canopyd: what is under test is
 * when it delegates, when it falls back to the in-process copy, and that a fork is removed
 * wherever it lives.
 */
import { describe, expect, it } from 'vitest'

import type { DbSource } from '@canopy/shared'

import { createViaCanopyd, MANAGED_BY } from '../../src/env/databases/via-canopyd'
import type { DbAdapter, DbContext, LogSink } from '../../src/env/types'
import type { Canopyd, CanopydFork } from '../../src/env/worktree/canopyd'
import { conflict } from '../../src/lib/errors'

const quiet: LogSink = { out: () => undefined, err: () => undefined, sys: () => undefined }

const ctx = (overrides: Partial<DbContext> = {}): DbContext => ({
  projectId: 'p1',
  projectName: 'fixture',
  projectPath: '/repo',
  worktreeId: 'wt-1',
  worktreeName: 'feat-x',
  worktreeBranch: 'feat/x',
  worktreePath: '/wt/feat-x',
  dataDir: '/data/wt-1',
  logs: quiet,
  allocatePort: async () => 0,
  env: {},
  ...overrides
})

const FORK: CanopydFork = { name: 'main', adapter: 'sqlite', status: 'ready', url: 'file:/state/db/main.db', env_key: 'MAIN_URL', forked_from: 'seed template', source: '/repo/data/seed.db', detail: { file: '/state/db/main.db' }, size_bytes: 1_572_864 }

function harness(opts: { version?: string | null; reset?: () => Promise<CanopydFork>; enabled?: boolean; engine?: DbAdapter['adapter'] } = {}) {
  const calls: string[] = []
  const canopyd = {
    version: async () => (opts.version === undefined ? '0.3.0' : opts.version),
    dbReset: async (input: { name: string; branch: string; from: string }) => {
      calls.push(`canopyd reset ${input.name} ${input.branch} --from ${input.from}`)
      return (opts.reset ?? (async () => FORK))()
    },
    dbDrop: async (input: { name: string }) => {
      calls.push(`canopyd drop ${input.name}`)
      return true
    },
    dbList: async () => [FORK]
  } as unknown as Canopyd
  const native: DbAdapter = {
    adapter: 'sqlite',
    available: async () => ({ ok: true }),
    ensureSource: async (name, _spec, _ctx, opts) => {
      calls.push(`native ensureSource ${name} refresh=${opts.refresh}`)
    },
    fork: async (name) => {
      calls.push(`native fork ${name}`)
      return { url: 'file:/data/wt-1/db/main.db', sourceDatabase: null, detail: { file: '/data/wt-1/db/main.db' }, sizeMb: 0 }
    },
    destroy: async (name) => {
      calls.push(`native destroy ${name}`)
    },
    status: async () => ({ ready: false, sizeMb: null })
  }
  const adapter = createViaCanopyd({ canopyd, native: { ...native, adapter: opts.engine ?? 'sqlite' }, enabled: () => opts.enabled ?? true })
  return { adapter, calls }
}

const SPEC = { adapter: 'sqlite' as const, options: {} }

/** One way canopyd cannot be used: what the harness is given, and what the fork is asked with. */
interface Case {
  version?: string | null
  enabled?: boolean
  ctx?: DbContext
  source?: DbSource
  sourceCtx?: DbContext
}

describe('database forks through canopyd', () => {
  it('has canopyd make a fresh fork, marks it, and clears whatever was held in-process', async () => {
    const { adapter, calls } = harness()
    const fork = await adapter.fork('main', SPEC, ctx(), 'template')
    expect(fork).toEqual({ url: 'file:/state/db/main.db', sourceDatabase: '/repo/data/seed.db', detail: { file: '/state/db/main.db', [MANAGED_BY]: 'canopyd' }, sizeMb: 1.5 })
    expect(calls).toEqual(['canopyd reset main feat/x --from template', 'native destroy main'])
  })

  it('names the source worktree by its branch', async () => {
    const { adapter, calls } = harness()
    await adapter.fork('main', SPEC, ctx(), { fromWorktree: 'wt-0' }, ctx({ worktreeId: 'wt-0', worktreeBranch: 'main' }))
    expect(calls[0]).toBe('canopyd reset main feat/x --from main')
  })

  it.each<[string, Case]>([
    ['a detached worktree', { ctx: ctx({ worktreeBranch: null }) }],
    ['a canopyd older than 0.3.0', { version: '0.2.0' }],
    ['no canopyd at all', { version: null }],
    ['a project with the tool turned off', { enabled: false }],
    ['a source worktree with no branch to name', { source: { fromWorktree: 'wt-0' }, sourceCtx: ctx({ worktreeBranch: null }) }]
  ])('forks in-process for %s', async (_label, opts) => {
    const { adapter, calls } = harness(opts)
    const fork = await adapter.fork('main', SPEC, opts.ctx ?? ctx(), opts.source ?? 'template', opts.sourceCtx)
    expect(calls).toEqual(['native fork main'])
    expect(fork.detail[MANAGED_BY]).toBeUndefined()
  })

  it('forks in-process when canopyd has never heard of the database, and only then', async () => {
    // canopyd reads its own canopy.yaml; the daemon's may be the project-home copy it cannot see.
    const unseen = harness({ reset: async () => Promise.reject(conflict('config_invalid', 'no database named main in canopy.yaml')) })
    await unseen.adapter.fork('main', SPEC, ctx(), 'template')
    expect(unseen.calls).toEqual(['canopyd reset main feat/x --from template', 'native fork main'])

    // A fork that failed is a failure. Quietly making a different one would hide it.
    const failed = harness({ reset: async () => Promise.reject(conflict('db_failed', 'database main: main has no fork of it to copy')) })
    await expect(failed.adapter.fork('main', SPEC, ctx(), 'template')).rejects.toThrow('has no fork of it')
    expect(failed.calls).toEqual(['canopyd reset main feat/x --from template'])
  })

  it('knows which canopyd first drove each engine', async () => {
    // Postgres arrived two releases after SQLite, and MySQL and Redis one after that.
    const fork = async (engine: DbAdapter['adapter'], version: string, runtime?: 'docker' | 'host'): Promise<string[]> => {
      const { adapter, calls } = harness({ engine, version })
      await adapter.fork('main', { ...SPEC, adapter: engine, ...(runtime ? { runtime } : {}) }, ctx(), 'template')
      return calls.map((call) => call.split(' ')[0] as string)
    }
    expect(await fork('postgres', '0.4.9')).toEqual(['native'])
    expect(await fork('postgres', '0.5.0')).toEqual(['canopyd', 'native'])
    expect(await fork('postgres', '1.0.0')).toEqual(['canopyd', 'native'])
    for (const engine of ['mysql', 'redis'] as const) {
      expect(await fork(engine, '0.5.9')).toEqual(['native'])
      expect(await fork(engine, '0.6.0')).toEqual(['canopyd', 'native'])
    }
  })

  it('keeps a Redis on the host for itself: canopyd would put it in a container', async () => {
    const host = harness({ engine: 'redis', version: '0.6.0' })
    const spec = { ...SPEC, adapter: 'redis' as const, runtime: 'host' as const }
    await host.adapter.fork('cache', spec, ctx(), 'template')
    await host.adapter.destroy('cache', spec, ctx())
    expect(host.calls).toEqual(['native fork cache', 'native destroy cache'])
    // In a container it is canopyd's, whether the file says so or leaves it to the default.
    const docker = harness({ engine: 'redis', version: '0.6.0' })
    await docker.adapter.fork('cache', { ...spec, runtime: 'docker' }, ctx(), 'template')
    expect(docker.calls[0]).toBe('canopyd reset cache feat/x --from template')
  })

  it('leaves a missing template for canopyd to build, and rebuilds one in-process', async () => {
    // A plain provision: canopyd builds the template as part of the fork, so nothing runs here.
    const provision = harness()
    await provision.adapter.ensureSource('main', SPEC, ctx(), { refresh: false })
    expect(provision.calls).toEqual([])
    // Without canopyd it is the in-process adapter's job, as it always was.
    const without = harness({ version: null })
    await without.adapter.ensureSource('main', SPEC, ctx(), { refresh: false })
    expect(without.calls).toEqual(['native ensureSource main refresh=false'])
    // A rebuild is asked for at project level, where there is no worktree to address.
    const refresh = harness()
    await refresh.adapter.ensureSource('main', SPEC, ctx({ worktreeBranch: null }), { refresh: true })
    expect(refresh.calls).toEqual(['native ensureSource main refresh=true'])
  })

  it('removes a fork wherever it lives', async () => {
    const { adapter, calls } = harness()
    await adapter.destroy('main', SPEC, ctx())
    expect(calls).toEqual(['canopyd drop main', 'native destroy main'])

    const without = harness({ version: null })
    await without.adapter.destroy('main', SPEC, ctx())
    expect(without.calls).toEqual(['native destroy main'])
  })

  it('reports the status of the fork canopyd has, else the in-process one', async () => {
    expect(await harness().adapter.status('main', SPEC, ctx())).toEqual({ ready: true, sizeMb: 1.5 })
    expect(await harness().adapter.status('other', SPEC, ctx())).toEqual({ ready: false, sizeMb: null })
    expect(await harness({ version: null }).adapter.status('main', SPEC, ctx())).toEqual({ ready: false, sizeMb: null })
  })
})
