import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openDb } from '../src/db'
import { routes, type ChangedFile, type HunkRef, type PullRequest } from '@canopy/shared'

import { startGraph } from '../src/graphs/brief'
import { hunkTable, type FileDiff } from '../src/graphs/hunks'
import { GraphStore } from '../src/graphs/store'
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
    expect(hunkTable(files).lines.get('a.ts#0')).toEqual([1, 1])
    expect(hunkTable(files).lines.get('logo.png#*')).toEqual([1, 1])
  })

  it('keeps headers but leaves bodies out once the budget is spent', () => {
    const { refs, text } = hunkTable(files, 12)
    expect(refs.size).toBe(4)
    expect(text).toContain('h1 @@ -1,1 +1,1 @@\n-old\n+new')
    expect(text).toContain('h2 @@ -20,1 +20,1 @@\n[body left out')
  })
})


describe('graph brief route', () => {
  let server: TestServer
  let repo: FixtureRepo
  let worktreeId: string
  let shas: string[]

  beforeEach(async () => {
    server = await createTestServer()
    repo = await createFixtureRepo()
    shas = [await repo.commit({ 'a.txt': 'a\n', 'b.txt': 'b\n' }, 'init')]
    const projectId = (await server.call('POST', routes.projects(), { path: repo.path, defaultBase: 'main' })).body.project.id
    worktreeId = (await server.call('GET', routes.project(projectId))).body.worktrees[0].id
  })
  afterEach(async () => {
    await server.close()
    repo.cleanup()
  })

  const start = async (body: object) => server.call('POST', routes.graphs(worktreeId), body)

  it('numbers the uncommitted hunks, new files included, and puts the preset and the user’s wording in the prompt', async () => {
    repo.write({ 'a.txt': 'a changed\n', 'c.txt': 'new\n' })
    const res = await start({ scope: { kind: 'uncommitted' }, preset: 'data-flow', instructions: 'by layer' })
    expect(res.status).toBe(201)
    expect(res.body.graph.ids).toEqual({ h1: { path: 'a.txt', hunk: 0 }, h2: { path: 'c.txt', hunk: 0 } } satisfies Record<string, HunkRef>)
    expect(res.body.graph).toMatchObject({ fingerprint: 'a.txt:1:1|c.txt:1:0', instructions: 'by layer', preset: 'data-flow', scope: { kind: 'uncommitted' } })
    expect(res.body.prompt).toContain('How the user wants it drawn:\nby layer')
    expect(res.body.prompt).toContain('feeds')
    expect(res.body.prompt).toContain('h2 @@')
    expect(res.body.graph.lines).toEqual({ 'a.txt#0': [1, 1], 'c.txt#0': [1, 0] })
  })

  it('defaults to features and refuses when there is nothing to draw', async () => {
    expect((await start({ scope: { kind: 'uncommitted' } })).status).toBe(400)
    repo.write({ 'a.txt': 'x\n' })
    expect((await start({ scope: { kind: 'uncommitted' } })).body.graph.preset).toBe('features')
  })

  it('cuts a run of commits from the parent of the first to the last, naming the commits', async () => {
    shas.push(await repo.commit({ 'a.txt': 'a2\n' }, 'second'))
    shas.push(await repo.commit({ 'b.txt': 'b3\n' }, 'third'))
    shas.push(await repo.commit({ 'c.txt': 'c4\n' }, 'fourth'))
    const res = await start({ scope: { kind: 'commits', from: shas[1], to: shas[2] } })
    expect(res.status).toBe(201)
    expect(Object.values(res.body.graph.ids).map((ref) => (ref as HunkRef).path)).toEqual(['a.txt', 'b.txt'])
    expect(res.body.prompt).toContain(`${shas[1]!.slice(0, 10)} second`)
    expect(res.body.prompt).not.toContain('fourth')

    const root = await start({ scope: { kind: 'commits', from: shas[0], to: shas[0] } })
    expect(Object.values(root.body.graph.ids)).toHaveLength(2)
    expect((await start({ scope: { kind: 'commits', from: shas[3], to: shas[1] } })).status).toBe(400)
  })

  it('cuts a run with a merge along first parents, and only between its own endpoints', async () => {
    // main: init → m1 → merge(side); side: init → s1.
    await repo.git('checkout', '-q', '-b', 'side')
    const s1 = await repo.commit({ 'b.txt': 'side\n' }, 'side work')
    await repo.git('checkout', '-q', 'main')
    const m1 = await repo.commit({ 'a.txt': 'main\n' }, 'main work')
    await repo.git('merge', '-q', '--no-ff', '-m', 'merge side', 'side')
    const merge = (await repo.git('rev-parse', 'HEAD')).trim()

    const res = await start({ scope: { kind: 'commits', from: m1, to: merge } })
    expect(res.status).toBe(201)
    expect(res.body.prompt).toContain(`${m1.slice(0, 10)} main work`)
    expect(res.body.prompt).toContain('merge side')
    expect(res.body.prompt).not.toContain('side work')
    // The diff runs from m1's parent to the merge: both files' changes, nothing before init.
    expect(Object.values(res.body.graph.ids).map((ref) => (ref as HunkRef).path).sort()).toEqual(['a.txt', 'b.txt'])
    // A side-branch commit is not on the merge's first-parent line, so it cannot start a run to it.
    expect((await start({ scope: { kind: 'commits', from: s1, to: merge } })).status).toBe(400)
  })

  it('keeps every graph, and its hunks still read once the change is committed', async () => {
    repo.write({ 'a.txt': 'a changed\n' })
    const first = (await start({ scope: { kind: 'uncommitted' } })).body.graph
    repo.write({ 'b.txt': 'b changed\n' })
    const second = (await start({ scope: { kind: 'branch' } })).body.graph
    await repo.commit({}, 'land it')

    const listed = (await server.call('GET', routes.graphs(worktreeId))).body.graphs
    expect(listed.map((g: { id: string }) => g.id)).toEqual([second.id, first.id])
    const patch = await server.call('GET', `${routes.treesFile(worktreeId, second.before, second.after)}?path=b.txt`)
    expect(patch.body.patch).toContain('+b changed')
  })

  it('learns a graph’s session and answer, and forgets it on delete', async () => {
    repo.write({ 'a.txt': 'a changed\n' })
    const { id, fingerprint } = (await start({ scope: { kind: 'uncommitted' } })).body.graph
    const session = { provider: 'claude', sessionId: 's1' }
    const result = { nodes: [{ id: '1', kind: 'feature', title: 'One', summary: '', layers: [], refs: [{ path: 'a.txt', hunk: 0 }], commits: [] }], edges: [], fingerprint }
    await server.call('PATCH', routes.graph(worktreeId, id), { session })
    const updated = (await server.call('PATCH', routes.graph(worktreeId, id), { result })).body.graph
    expect(updated).toMatchObject({ session, result })

    expect((await server.call('DELETE', routes.graph(worktreeId, id))).status).toBe(204)
    expect((await server.call('GET', routes.graphs(worktreeId))).body.graphs).toEqual([])
  })
})

describe('a pull-request graph', () => {
  const pr = { number: 7, title: 'Refunds', body: 'Adds refunds.', headSha: 'head1', commitLog: [{ sha: 'abcdef1234567', subject: 'Add refunds' }], filesRange: { before: 'b0', after: 'a1' } } as unknown as PullRequest
  const deps = (found: PullRequest | null) => {
    const added: object[] = []
    return {
      added,
      deps: {
        history: {
          snapshot: async () => ({ kind: 'trees' as const, before: 'x', after: 'y' }),
          commitRange: async () => ({ spec: { kind: 'trees' as const, before: 'x', after: 'y' }, commits: [] }),
          pinned: async (_: string, rev: string) => `tree-${rev}`,
          trees: async () => ({ files: [{ path: 'a.ts', status: 'M', additions: 1, deletions: 1, binary: false }] as ChangedFile[] }),
          filePatch: async () => ({ patch: [`diff --git a/a.ts b/a.ts`, '--- a/a.ts', '+++ b/a.ts', '@@ -1,1 +1,1 @@', '-o', '+n'].join('\n') + '\n' })
        },
        github: { read: async () => ({ pr: found }), pullRequest: async (_: string, number: number) => ({ ...pr, number, headSha: `head-${number}` }) },
        store: { add: (_: string, graph: object) => (added.push(graph), { ...graph, id: 'g1', createdAt: 0 }) }
      } as unknown as Parameters<typeof startGraph>[0]
    }
  }

  it('pins GitHub’s range and briefs the PR’s words and commits', async () => {
    const { deps: d, added } = deps(pr)
    const { prompt } = await startGraph(d, 'wt', { scope: { kind: 'pull-request' } })
    expect(added[0]).toMatchObject({ before: 'tree-b0', after: 'tree-a1', prNumber: 7, headSha: 'head1' })
    expect(prompt).toContain('#7 Refunds\n\nAdds refunds.')
    expect(prompt).toContain('abcdef1234 Add refunds')
  })

  it('draws a PR picked by number, whichever branch it is from', async () => {
    const { deps: d, added } = deps(null)
    const { prompt } = await startGraph(d, 'wt', { scope: { kind: 'pull-request', number: 42 } })
    expect(added[0]).toMatchObject({ scope: { kind: 'pull-request', number: 42 }, prNumber: 42, headSha: 'head-42' })
    expect(prompt).toContain('#42 Refunds')
  })

  it('refuses a branch with no pull request', async () => {
    await expect(startGraph(deps(null).deps, 'wt', { scope: { kind: 'pull-request' } })).rejects.toThrow(/no pull request/)
  })
})

describe('groupings made before graphs', () => {
  it('open as graphs of the same change', async () => {
    const db = openDb(':memory:')
    db.pragma('foreign_keys = OFF')
    const result = { groups: [{ id: '1', title: 'F', summary: '', layers: [], refs: [{ path: 'a', hunk: 0 }], parts: [{ id: '1.1', title: 'P', summary: '', layers: [], refs: [] }] }, { id: '2', title: 'G', summary: '', layers: [], refs: [], parts: [] }], links: [{ from: '1', to: '2' }], fingerprint: 'fp' }
    db.prepare(
      `INSERT INTO change_groupings (id, worktree_id, against, instructions, before_tree, after_tree, ids_json, fingerprint, result_json, created_at) VALUES ('old', 'w', 'base', '', 'b', 'a', '{}', 'fp', ?, 1)`
    ).run(JSON.stringify(result))
    const store = new GraphStore({ db, worktrees: { row: () => ({}) } as never })
    const [graph] = store.list('w')
    expect(graph).toMatchObject({ id: 'old', scope: { kind: 'branch' }, preset: 'features' })
    expect(graph!.result!.edges).toEqual([
      { from: '1', to: '1.1', kind: 'contains' },
      { from: '2', to: '1', kind: 'builds-on' }
    ])
    expect(db.prepare('SELECT COUNT(*) FROM change_groupings').pluck().get()).toBe(0)
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
