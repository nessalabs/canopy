import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { routes, type ChangedFile, type HunkRef } from '@canopy/shared'

import { hunkTable, type FileDiff } from '../src/drafts/groups'
import { createFixtureRepo, type FixtureRepo } from './helpers/fixture-repo'
import { createTestServer, type TestServer } from './helpers/test-server'

const file = (path: string, extra: Partial<ChangedFile> = {}): ChangedFile =>
  ({ path, status: 'M', additions: 1, deletions: 1, binary: false, staged: 'unstaged', conflicted: false, headSha: null, ...extra }) as ChangedFile

const patch = (path: string, ...hunks: string[]): string => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...hunks].join('\n') + '\n'
const hunk = (at: number, body = ['-old', '+new']): string => [`@@ -${at},1 +${at},1 @@`, ...body].join('\n')

describe('hunkTable', () => {
  const files: FileDiff[] = [
    { file: file('a.ts'), patch: patch('a.ts', hunk(1), hunk(20)) },
    { file: file('logo.png', { binary: true }), patch: null },
    { file: file('b.ts'), patch: patch('b.ts', hunk(5)) }
  ]

  it('numbers hunks in diff order and gives hunkless files a whole-file id', () => {
    const { refs, text } = hunkTable(files)
    expect([...refs]).toEqual([
      ['h1', { path: 'a.ts', hunk: 0 }],
      ['h2', { path: 'a.ts', hunk: 1 }],
      ['f3', { path: 'logo.png' }],
      ['h4', { path: 'b.ts', hunk: 0 }]
    ])
    expect(text).toContain('### logo.png (binary)\nf3 whole file')
    expect(text).toContain('h4 @@ -5,1 +5,1 @@\n-old\n+new')
  })

  it('keeps headers but leaves bodies out once the budget is spent', () => {
    const { refs, text } = hunkTable(files, 12)
    expect(refs.size).toBe(4)
    expect(text).toContain('h1 @@ -1,1 +1,1 @@\n-old\n+new')
    expect(text).toContain('h2 @@ -20,1 +20,1 @@\n[body left out')
  })
})


describe('group brief route', () => {
  let server: TestServer
  let repo: FixtureRepo
  let worktreeId: string

  beforeEach(async () => {
    server = await createTestServer()
    repo = await createFixtureRepo()
    await repo.commit({ 'a.txt': 'a\n', 'b.txt': 'b\n' }, 'init')
    const projectId = (await server.call('POST', routes.projects(), { path: repo.path, defaultBase: 'main' })).body.project.id
    worktreeId = (await server.call('GET', routes.project(projectId))).body.worktrees[0].id
  })
  afterEach(async () => {
    await server.close()
    repo.cleanup()
  })

  const start = async (body: object) => server.call('POST', routes.groupings(worktreeId), body)

  it('numbers the working-tree hunks, new files included, and puts the user’s wording in the prompt', async () => {
    repo.write({ 'a.txt': 'a changed\n', 'c.txt': 'new\n' })
    const res = await start({ against: 'head', instructions: 'by layer' })
    expect(res.status).toBe(200)
    expect(res.body.grouping.ids).toEqual({ h1: { path: 'a.txt', hunk: 0 }, h2: { path: 'c.txt', hunk: 0 } } satisfies Record<string, HunkRef>)
    expect(res.body.grouping.fingerprint).toBe('a.txt:1:1|c.txt:1:0')
    expect(res.body.grouping.instructions).toBe('by layer')
    expect(res.body.prompt).toContain('How the user wants it grouped:\nby layer')
    expect(res.body.prompt).toContain('h2 @@')
  })

  it('refuses when there is nothing to group', async () => {
    expect((await start({ against: 'head' })).status).toBe(400)
  })

  it('keeps every grouping, and its hunks still read once the change is committed', async () => {
    repo.write({ 'a.txt': 'a changed\n' })
    const first = (await start({ against: 'head' })).body.grouping
    repo.write({ 'b.txt': 'b changed\n' })
    const second = (await start({ against: 'head', instructions: 'by layer' })).body.grouping
    await repo.commit({}, 'land it')

    const listed = (await server.call('GET', routes.groupings(worktreeId))).body.groupings
    expect(listed.map((g: { id: string }) => g.id)).toEqual([second.id, first.id])
    const patch = await server.call('GET', `${routes.treesFile(worktreeId, second.before, second.after)}?path=b.txt`)
    expect(patch.body.patch).toContain('+b changed')
  })

  it('learns a grouping’s session and answer, and forgets it on delete', async () => {
    repo.write({ 'a.txt': 'a changed\n' })
    const { id, fingerprint } = (await start({ against: 'head' })).body.grouping
    const session = { provider: 'claude', sessionId: 's1' }
    const result = { groups: [{ id: '1', title: 'One', summary: '', layers: [], refs: [{ path: 'a.txt', hunk: 0 }], parts: [] }], links: [], fingerprint }
    await server.call('PATCH', routes.grouping(worktreeId, id), { session })
    const updated = (await server.call('PATCH', routes.grouping(worktreeId, id), { result })).body.grouping
    expect(updated).toMatchObject({ session, result })

    expect((await server.call('DELETE', routes.grouping(worktreeId, id))).status).toBe(204)
    expect((await server.call('GET', routes.groupings(worktreeId))).body.groupings).toEqual([])
  })
})

describe('git agent history route', () => {
  let server: TestServer
  let repo: FixtureRepo
  let worktreeId: string

  beforeEach(async () => {
    server = await createTestServer()
    repo = await createFixtureRepo()
    await repo.commit({ 'a.txt': 'a\n' }, 'init')
    const projectId = (await server.call('POST', routes.projects(), { path: repo.path, defaultBase: 'main' })).body.project.id
    worktreeId = (await server.call('GET', routes.project(projectId))).body.worktrees[0].id
  })
  afterEach(async () => {
    await server.close()
    repo.cleanup()
  })

  it('remembers each conversation once, titled from the provider listing', async () => {
    const ref = { provider: 'claude', sessionId: 's1' }
    expect((await server.call('POST', routes.gitAgentSessions(worktreeId), ref)).status).toBe(204)
    await server.call('POST', routes.gitAgentSessions(worktreeId), ref)
    const sessions = (await server.call('GET', routes.gitAgentSessions(worktreeId))).body.sessions
    expect(sessions).toEqual([{ ...ref, title: 'fixture session', createdAt: expect.any(Number), updatedAt: expect.any(Number) }])
  })
})
