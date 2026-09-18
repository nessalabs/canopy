/**
 * The adapter that sends SQLite forks to canopyd, against a fake canopyd: what is under test is
 * when it delegates, when it falls back to the in-process copy, and that a fork is removed
 * wherever it lives.
 */
import { describe, expect, it } from 'vitest'

import type { DbSource } from '@canopy/shared'

import { createSqliteViaCanopyd, MANAGED_BY } from '../../src/env/databases/sqlite-canopyd'
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

function harness(opts: { version?: string | null; reset?: () => Promise<CanopydFork>; enabled?: boolean } = {}) {
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
    ensureSource: async () => undefined,
    fork: async (name) => {
      calls.push(`native fork ${name}`)
      return { url: 'file:/data/wt-1/db/main.db', sourceDatabase: null, detail: { file: '/data/wt-1/db/main.db' }, sizeMb: 0 }
    },
    destroy: async (name) => {
      calls.push(`native destroy ${name}`)
    },
    status: async () => ({ ready: false, sizeMb: null })
  }
  const adapter = createSqliteViaCanopyd({ canopyd, native, enabled: () => opts.enabled ?? true })
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

describe('sqlite forks through canopyd', () => {
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
