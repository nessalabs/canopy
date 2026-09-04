import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { routes } from '@canopy/shared'

import { FILE_CAP_BYTES, PATCH_CAP_BYTES } from '../src/git/diff'
import { repoPath } from '../src/worktrees/history'
import { createFixtureRepo, type FixtureRepo } from './helpers/fixture-repo'
import { createTestServer, type TestServer } from './helpers/test-server'

describe('changes and history', () => {
  let server: TestServer
  let repo: FixtureRepo
  let worktreeId: string
  let secondSha: string
  beforeEach(async () => {
    server = await createTestServer()
    repo = await createFixtureRepo()
    await repo.commit({ 'a.txt': 'one\n', 'b.txt': 'b\n' }, 'init')
    secondSha = (await repo.commit({ 'a.txt': 'one\ntwo\n' }, 'add two')).trim()
    await repo.git('checkout', '-q', '-b', 'feature')
    await repo.commit({ 'c.txt': 'committed on branch\n' }, 'branch work')
    repo.write({ 'a.txt': 'one\ntwo\nthree\n', 'new.txt': 'untracked\n' })
    const project = (await server.call('POST', routes.projects(), { path: repo.path, defaultBase: 'main' })).body.project
    worktreeId = (await server.call('GET', routes.project(project.id))).body.worktrees[0].id
  })
  afterEach(async () => {
    await server.close()
    repo.cleanup()
  })

  it('browses one directory level of tracked and untracked files, hiding ignored ones', async () => {
    repo.write({ 'src/lib/deep.ts': 'x\n', 'src/top.ts': 'y\n', '.gitignore': 'ignored.log\n', 'ignored.log': 'no\n' })
    const root = (await server.call('GET', routes.tree(worktreeId))).body
    expect(root.path).toBe('')
    expect(root.entries.map((e: { path: string }) => e.path)).toEqual(['src', '.gitignore', 'a.txt', 'b.txt', 'c.txt', 'new.txt'])
    const src = (await server.call('GET', `${routes.tree(worktreeId)}?path=src`)).body
    expect(src.entries).toEqual([
      { name: 'lib', path: 'src/lib', kind: 'dir' },
      { name: 'top.ts', path: 'src/top.ts', kind: 'file' }
    ])
  })

  it('reads a file from the working tree or at a revision, capping size and binaries', async () => {
    const now = (await server.call('GET', `${routes.file(worktreeId)}?path=a.txt`)).body
    expect(now).toEqual({ path: 'a.txt', content: 'one\ntwo\nthree\n', truncated: false, binary: false, size: 14 })
    const then = (await server.call('GET', `${routes.file(worktreeId)}?path=a.txt&rev=${secondSha}`)).body
    expect(then.content).toBe('one\ntwo\n')
    expect((await server.call('GET', `${routes.file(worktreeId)}?path=nope.txt`)).status).toBe(404)
    repo.write({ 'big.txt': 'x'.repeat(FILE_CAP_BYTES + 1), 'bin.dat': 'a\0b' })
    expect((await server.call('GET', `${routes.file(worktreeId)}?path=big.txt`)).body).toMatchObject({ content: null, truncated: true })
    expect((await server.call('GET', `${routes.file(worktreeId)}?path=bin.dat`)).body).toMatchObject({ content: null, binary: true, size: 3 })
  })

  it('rejects paths that leave the worktree', async () => {
    expect((await server.call('GET', `${routes.file(worktreeId)}?path=../etc/passwd`)).status).toBe(400)
    expect((await server.call('GET', `${routes.tree(worktreeId)}?path=/etc`)).status).toBe(400)
    expect(repoPath('./src/../src/x.ts/')).toBe('src/x.ts')
    expect(repoPath('.')).toBe('')
  })

  it('lists working-tree changes vs HEAD and vs base', async () => {
    const head = (await server.call('GET', routes.changes(worktreeId))).body
    expect(head.against).toBe('head')
    expect(head.files).toEqual([
      { path: 'a.txt', status: 'M', additions: 1, deletions: 0, binary: false },
      { path: 'new.txt', status: 'U', additions: 1, deletions: 0, binary: false }
    ])
    const base = (await server.call('GET', `${routes.changes(worktreeId)}?against=base`)).body
    expect(base.files.map((f: { path: string }) => f.path)).toEqual(['a.txt', 'c.txt', 'new.txt'])
    expect(base.baseBranch).toBe('main')
  })

  it('returns unified patches for tracked and untracked files', async () => {
    const tracked = (await server.call('GET', `${routes.changesFile(worktreeId)}?path=a.txt`)).body
    expect(tracked.patch).toContain('diff --git a/a.txt b/a.txt')
    expect(tracked.patch).toContain('+three')
    const untracked = (await server.call('GET', `${routes.changesFile(worktreeId)}?path=new.txt`)).body
    expect(untracked.patch).toContain('+untracked')
    expect(untracked.truncated).toBe(false)
  })

  it('pages the log and shows a commit with its files and patch', async () => {
    const page = (await server.call('GET', `${routes.log(worktreeId)}?limit=2`)).body
    expect(page.commits.map((c: { subject: string }) => c.subject)).toEqual(['branch work', 'add two'])
    expect(page.hasMore).toBe(true)
    const rest = (await server.call('GET', `${routes.log(worktreeId)}?limit=2&skip=2`)).body
    expect(rest.commits.map((c: { subject: string }) => c.subject)).toEqual(['init'])
    expect(rest.hasMore).toBe(false)

    const commit = (await server.call('GET', routes.commit(worktreeId, secondSha))).body
    expect(commit.commit).toMatchObject({ subject: 'add two', author: 'Fixture' })
    expect(commit.files).toEqual([{ path: 'a.txt', status: 'M', additions: 1, deletions: 0, binary: false }])
    const patch = (await server.call('GET', `${routes.commitFile(worktreeId, secondSha)}?path=a.txt`)).body
    expect(patch.patch).toContain('+two')

    const root = (await server.call('GET', routes.commit(worktreeId, rest.commits[0].sha))).body
    expect(root.files.map((f: { path: string }) => f.path)).toEqual(['a.txt', 'b.txt'])
  })

  it('caps oversized patches', async () => {
    repo.write({ 'big.txt': 'x'.repeat(PATCH_CAP_BYTES + 10) + '\n' })
    const big = (await server.call('GET', `${routes.changesFile(worktreeId)}?path=big.txt`)).body
    expect(big).toMatchObject({ patch: null, truncated: true })
  })

  it('handles a repo with no commits yet (unborn HEAD)', async () => {
    const empty = await createFixtureRepo()
    empty.write({ 'a.txt': 'new\n' })
    await empty.git('add', 'a.txt')
    empty.write({ 'b.txt': 'untracked\n' })
    const project = (await server.call('POST', routes.projects(), { path: empty.path })).body.project
    const wt = (await server.call('GET', routes.project(project.id))).body.worktrees[0]
    expect(wt.status.lastCommit).toBeNull()

    const head = await server.call('GET', routes.changes(wt.id))
    expect(head.status).toBe(200)
    expect(head.body.files.map((f: { path: string; status: string }) => [f.path, f.status])).toEqual([['a.txt', 'A'], ['b.txt', 'U']])
    expect((await server.call('GET', `${routes.changesFile(wt.id)}?path=a.txt`)).body.patch).toContain('+new')
    expect((await server.call('GET', routes.log(wt.id))).body).toEqual({ commits: [], hasMore: false })
    empty.cleanup()
  })
})
