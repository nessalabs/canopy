import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { routes } from '@canopy/shared'

import { createFixtureRepo, type FixtureRepo } from './helpers/fixture-repo'
import { createTestServer, type TestServer } from './helpers/test-server'

const hook = (event: 'PreToolUse' | 'PostToolUse', cwd: string, toolUseId: string) => ({
  hook_event_name: event,
  session_id: 'sess-1',
  cwd,
  tool_name: 'Bash',
  tool_use_id: toolUseId,
  tool_input: { command: 'true' },
  transcript_path: '/ignored'
})

const rewind = routes.rewind('claude', 'sess-1')

describe('rewinding a turn from a Canopy snapshot', () => {
  let server: TestServer
  let repo: FixtureRepo

  beforeEach(async () => {
    server = await createTestServer()
    repo = await createFixtureRepo()
    await repo.commit({ 'src/a.ts': 'export const a = 1\n', 'docs/gone.md': '# keep me\n' }, 'init')
    const { body } = await server.call('POST', '/api/v1/projects', { path: repo.path })
    await server.call('GET', `/api/v1/projects/${body.project.id}`)
  })
  afterEach(async () => {
    await server.close()
    repo.cleanup()
  })

  /**
   * The tree a turn would have snapshotted before its first write. Driving the hook receiver is
   * how one is really made, so that is how the fixture makes one too — the scratch file exists
   * only because a call that changed nothing records no edit to read the tree off.
   */
  const preTurnTree = async (toolUseId: string): Promise<string> => {
    await server.call('POST', '/api/v1/hooks/claude', hook('PreToolUse', repo.path, toolUseId))
    writeFileSync(join(repo.path, 'probe.tmp'), 'x\n')
    await server.call('POST', '/api/v1/hooks/claude', hook('PostToolUse', repo.path, toolUseId))
    rmSync(join(repo.path, 'probe.tmp'))
    const { body } = await server.call('GET', routes.agentEdits('claude', 'sess-1'))
    return body.edits[0].beforeTree as string
  }

  /** What the turn did: changed one file, created another, deleted a third. */
  const doTurnWork = (): void => {
    writeFileSync(join(repo.path, 'src/a.ts'), 'export const a = 2\n')
    writeFileSync(join(repo.path, 'src/new.ts'), 'export const brand = "new"\n')
    rmSync(join(repo.path, 'docs/gone.md'))
  }

  it('puts every path back — restored, recreated or removed — and leaves the index alone', async () => {
    const tree = await preTurnTree('tu-1')
    doTurnWork()

    const { status, body } = await server.call('POST', rewind, { messageId: 'u-1', cwd: repo.path, tree })
    expect(status).toBe(200)
    expect(body).toMatchObject({ source: 'snapshot', canRewind: true })
    expect([...body.filesChanged].sort()).toEqual(['docs/gone.md', 'src/a.ts', 'src/new.ts'])
    expect(body.insertions).toBeGreaterThan(0)
    expect(body.deletions).toBeGreaterThan(0)

    // A modified file is back, a deleted one has returned, and one the turn created is gone —
    // which is the thing a provider's own checkpoints cannot do for a file a shell command wrote.
    expect(readFileSync(join(repo.path, 'src/a.ts'), 'utf8')).toBe('export const a = 1\n')
    expect(readFileSync(join(repo.path, 'docs/gone.md'), 'utf8')).toBe('# keep me\n')
    expect(existsSync(join(repo.path, 'src/new.ts'))).toBe(false)

    // The commit panel *is* the index: a rewind of the worktree must not stage or unstage anything.
    expect(await repo.git('diff', '--cached', '--name-only')).toBe('')
    expect(await repo.git('status', '--porcelain')).toBe('')
  })

  it('does not leave a staged add behind for a file it deleted', async () => {
    const tree = await preTurnTree('tu-2')
    doTurnWork()
    // The agent staged what it created; removing the file alone would leave the index claiming a
    // file that is no longer there.
    await repo.git('add', 'src/new.ts')

    expect((await server.call('POST', rewind, { messageId: 'u-1', cwd: repo.path, tree })).status).toBe(200)
    expect(existsSync(join(repo.path, 'src/new.ts'))).toBe(false)
    expect(await repo.git('diff', '--cached', '--name-only')).toBe('')
  })

  it('reports what a dry run would do and touches nothing', async () => {
    const tree = await preTurnTree('tu-3')
    doTurnWork()
    const before = await repo.git('status', '--porcelain')

    const { body } = await server.call('POST', rewind, { messageId: 'u-1', cwd: repo.path, tree, dryRun: true })
    expect(body.canRewind).toBe(true)
    expect([...body.filesChanged].sort()).toEqual(['docs/gone.md', 'src/a.ts', 'src/new.ts'])

    expect(readFileSync(join(repo.path, 'src/a.ts'), 'utf8')).toBe('export const a = 2\n')
    expect(existsSync(join(repo.path, 'src/new.ts'))).toBe(true)
    expect(existsSync(join(repo.path, 'docs/gone.md'))).toBe(false)
    expect(await repo.git('status', '--porcelain')).toBe(before)
  })

  it('refuses a sha this repo does not hold as a tree, without touching the worktree', async () => {
    doTurnWork()
    const notATree = await repo.git('rev-parse', 'HEAD')
    const { status, body } = await server.call('POST', rewind, { messageId: 'u-1', cwd: repo.path, tree: notATree })
    // A commit sha is a well-formed sha that `git restore --source` would happily take; only
    // `cat-file -t` says it is not one of Canopy's snapshots.
    expect(status).toBe(200)
    expect(body).toMatchObject({ source: 'snapshot', canRewind: false, filesChanged: [] })
    expect(body.error).toContain(notATree)
    expect(readFileSync(join(repo.path, 'src/a.ts'), 'utf8')).toBe('export const a = 2\n')
  })

  it('reports an unchanged worktree as a rewind with nothing to do', async () => {
    const tree = await preTurnTree('tu-4')
    const { body } = await server.call('POST', rewind, { messageId: 'u-1', cwd: repo.path, tree })
    expect(body).toEqual({ source: 'snapshot', canRewind: true, filesChanged: [], insertions: 0, deletions: 0 })
  })
})

describe('rewind route', () => {
  let server: TestServer
  let repo: FixtureRepo

  beforeEach(async () => {
    server = await createTestServer()
    repo = await createFixtureRepo()
    await repo.commit({ 'src/a.ts': 'export const a = 1\n' }, 'init')
    const { body } = await server.call('POST', '/api/v1/projects', { path: repo.path })
    await server.call('GET', `/api/v1/projects/${body.project.id}`)
  })
  afterEach(async () => {
    await server.close()
    repo.cleanup()
  })

  it('hands a rewind with no tree to the adapter, and reports a refusal as a result', async () => {
    const { status, body } = await server.call('POST', rewind, { messageId: 'u-5', cwd: repo.path })
    expect(status).toBe(200)
    expect(body).toEqual({ source: 'checkpoint', canRewind: true, filesChanged: ['src/a.ts'], insertions: 2, deletions: 1 })
    expect(server.agent.rewinds).toEqual([{ sessionId: 'sess-1', input: { messageId: 'u-5', cwd: repo.path } }])

    // "There is no checkpoint for that message" is an answer the client renders, not a failure.
    const refused = await server.call('POST', rewind, { messageId: server.agent.unknownMessageId, cwd: repo.path })
    expect(refused.status).toBe(200)
    expect(refused.body).toMatchObject({ canRewind: false, error: 'no checkpoint for that message' })
  })

  it('404s a provider that cannot rewind at all', async () => {
    server.agent.rewind = undefined
    const { status, body } = await server.call('POST', rewind, { messageId: 'u-5', cwd: repo.path })
    expect(status).toBe(404)
    expect(body.error.code).toBe('unsupported')
  })

  it('refuses a cwd Canopy does not manage, and a body that names no message', async () => {
    const unknown = await server.call('POST', rewind, { messageId: 'u-5', cwd: '/somewhere/else' })
    expect(unknown.status).toBe(400)
    expect(unknown.body.error.code).toBe('unknown_worktree')
    // Nothing reached the adapter: the cwd is checked before anything is asked to act on it.
    expect(server.agent.rewinds).toEqual([])

    expect((await server.call('POST', rewind, { cwd: repo.path })).status).toBe(400)
    // A `tree` that is not a sha is a client bug, not a snapshot to go looking for.
    expect((await server.call('POST', rewind, { messageId: 'u-5', cwd: repo.path, tree: 'HEAD~1' })).status).toBe(400)
  })
})
