import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { DatabaseSpec } from '@canopy/shared'

import { ApiError } from '../../src/lib/errors'
import { createSqliteAdapter } from '../../src/env/databases/sqlite'
import type { DbContext, LogSink } from '../../src/env/types'

function recordingSink(): LogSink & { lines: string[] } {
  const lines: string[] = []
  return { lines, out: (text) => lines.push(text), err: (text) => lines.push(text), sys: (text) => lines.push(text) }
}

const spec = (partial: Partial<DatabaseSpec> = {}): DatabaseSpec => ({ adapter: 'sqlite', options: {}, ...partial })

describe('sqlite adapter', () => {
  const adapter = createSqliteAdapter()
  let root: string
  let projectPath: string
  let logs: ReturnType<typeof recordingSink>

  const contextFor = (worktree: string): DbContext => ({
    projectId: 'p1',
    projectName: 'Canopy App',
    projectPath,
    worktreeId: `wt-${worktree}`,
    worktreeName: worktree,
    worktreeBranch: null,
    worktreePath: join(root, worktree),
    dataDir: join(root, 'data', worktree),
    logs,
    allocatePort: async () => 40000,
    env: {}
  })

  const forkPath = (worktree: string, name: string): string => join(root, 'data', worktree, 'db', `${name}.db`)

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'canopy-sqlite-'))
    projectPath = join(root, 'repo')
    mkdirSync(join(projectPath, 'db'), { recursive: true })
    writeFileSync(join(projectPath, 'db', 'seed.db'), 'SEED-CONTENT')
    logs = recordingSink()
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('reports what it will use as a template without building anything', async () => {
    expect(adapter.adapter).toBe('sqlite')
    expect(await adapter.available()).toEqual({ ok: true })

    await adapter.ensureSource('main', spec({ source: 'db/seed.db' }), contextFor('a'), { refresh: false })
    expect(logs.lines.some((line) => line.includes('seed db/seed.db'))).toBe(true)

    await adapter.ensureSource('main', spec({ source: 'db/missing.db' }), contextFor('a'), { refresh: false })
    expect(logs.lines.some((line) => line.includes('not found'))).toBe(true)

    await adapter.ensureSource('main', spec(), contextFor('a'), { refresh: false })
    expect(logs.lines.some((line) => line.includes('no source'))).toBe(true)
  })

  it('forks by copying the seed file and reports a file: url', async () => {
    const ctx = contextFor('a')
    const result = await adapter.fork('main', spec({ source: 'db/seed.db' }), ctx, 'template')

    const file = forkPath('a', 'main')
    expect(result).toEqual({ url: `file:${file}`, sourceDatabase: join(projectPath, 'db', 'seed.db'), detail: { file }, sizeMb: 0 })
    expect(readFileSync(file, 'utf8')).toBe('SEED-CONTENT')
    expect(await adapter.status('main', spec(), ctx)).toEqual({ ready: true, sizeMb: 0 })
  })

  it('creates an empty file for source empty, and when the seed is missing', async () => {
    const ctx = contextFor('a')
    await adapter.fork('main', spec({ source: 'db/seed.db' }), ctx, 'empty')
    expect(readFileSync(forkPath('a', 'main'), 'utf8')).toBe('')

    await adapter.fork('other', spec({ source: 'db/nope.db' }), ctx, 'template')
    expect(readFileSync(forkPath('a', 'other'), 'utf8')).toBe('')
    expect(existsSync(forkPath('a', 'other'))).toBe(true)
  })

  it('forks from another worktree, WAL sidecars included', async () => {
    const source = contextFor('a')
    await adapter.fork('main', spec({ source: 'db/seed.db' }), source, 'template')
    writeFileSync(`${forkPath('a', 'main')}-wal`, 'WAL')

    const target = contextFor('b')
    const result = await adapter.fork('main', spec(), target, { fromWorktree: source.worktreeId }, source)

    expect(readFileSync(forkPath('b', 'main'), 'utf8')).toBe('SEED-CONTENT')
    expect(readFileSync(`${forkPath('b', 'main')}-wal`, 'utf8')).toBe('WAL')
    expect(result.url).toBe(`file:${forkPath('b', 'main')}`)
  })

  it('fails loudly when a cross-worktree fork has no source context', async () => {
    await expect(adapter.fork('main', spec(), contextFor('b'), { fromWorktree: 'wt-a' })).rejects.toBeInstanceOf(ApiError)
    await expect(adapter.fork('main', spec(), contextFor('b'), { fromWorktree: 'wt-a' })).rejects.toMatchObject({ code: 'db_sqlite_failed', status: 500 })
  })

  it('re-forking replaces the file and drops stale sidecars', async () => {
    const ctx = contextFor('a')
    await adapter.fork('main', spec({ source: 'db/seed.db' }), ctx, 'template')
    writeFileSync(`${forkPath('a', 'main')}-shm`, 'SHM')

    writeFileSync(join(projectPath, 'db', 'seed.db'), 'NEW-SEED')
    await adapter.fork('main', spec({ source: 'db/seed.db' }), ctx, 'template')

    expect(readFileSync(forkPath('a', 'main'), 'utf8')).toBe('NEW-SEED')
    expect(existsSync(`${forkPath('a', 'main')}-shm`)).toBe(false)
  })

  it('destroy removes the database and its sidecars, and is safe to repeat', async () => {
    const ctx = contextFor('a')
    await adapter.fork('main', spec({ source: 'db/seed.db' }), ctx, 'template')
    writeFileSync(`${forkPath('a', 'main')}-wal`, 'WAL')

    await adapter.destroy('main', spec(), ctx)
    await adapter.destroy('main', spec(), ctx)

    expect(existsSync(forkPath('a', 'main'))).toBe(false)
    expect(existsSync(`${forkPath('a', 'main')}-wal`)).toBe(false)
    expect(await adapter.status('main', spec(), ctx)).toEqual({ ready: false, sizeMb: null })
  })

  it('reports the size of a non-trivial fork', async () => {
    writeFileSync(join(projectPath, 'db', 'seed.db'), Buffer.alloc(3 * 1024 * 1024, 1))
    const ctx = contextFor('a')
    const result = await adapter.fork('main', spec({ source: 'db/seed.db' }), ctx, 'template')
    expect(result.sizeMb).toBe(3)
  })
})
