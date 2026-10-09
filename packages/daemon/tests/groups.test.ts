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

  it('numbers the working-tree hunks, new files included, and puts the user’s wording in the prompt', async () => {
    repo.write({ 'a.txt': 'a changed\n', 'c.txt': 'new\n' })
    const res = await server.call('POST', routes.groupBrief(worktreeId), { against: 'head', instructions: 'by layer' })
    expect(res.status).toBe(200)
    expect(res.body.ids).toEqual({ h1: { path: 'a.txt', hunk: 0 }, h2: { path: 'c.txt', hunk: 0 } } satisfies Record<string, HunkRef>)
    expect(res.body.fingerprint).toContain('a.txt:1:1')
    expect(res.body.prompt).toContain('How the user wants it grouped:\nby layer')
    expect(res.body.prompt).toContain('h2 @@')
  })

  it('refuses when there is nothing to group', async () => {
    expect((await server.call('POST', routes.groupBrief(worktreeId), { against: 'head' })).status).toBe(400)
  })
})
