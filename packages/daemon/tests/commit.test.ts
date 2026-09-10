import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { hashPatch, routes, type ChangedFile, type ChangesResponse, type HunkStatesResponse } from '@canopy/shared'

import { createFixtureRepo, type FixtureRepo } from './helpers/fixture-repo'
import { createTestServer, type TestServer } from './helpers/test-server'

/** A 30-line file, so edits to lines 1, 15 and 30 stay three separate hunks at -U3. */
const lines = (transform: (line: number) => string = (line) => `line ${line}`): string =>
  `${Array.from({ length: 30 }, (_, index) => transform(index + 1)).join('\n')}\n`

const EDITED = lines((line) => (line === 1 || line === 15 || line === 30 ? `EDITED ${line}` : `line ${line}`))

describe('commit panel', () => {
  let server: TestServer
  let repo: FixtureRepo
  let worktreeId: string

  const changes = async (): Promise<ChangesResponse> => (await server.call('GET', routes.changes(worktreeId))).body
  const fileNamed = async (path: string): Promise<ChangedFile | undefined> => (await changes()).files.find((file) => file.path === path)
  const hunks = async (path: string): Promise<HunkStatesResponse> =>
    (await server.call('GET', `${routes.stageHunks(worktreeId)}?path=${encodeURIComponent(path)}`)).body

  beforeEach(async () => {
    server = await createTestServer()
    repo = await createFixtureRepo()
    await repo.commit({ 'big.txt': lines(), 'a.txt': 'a\n', 'b.txt': 'b\n' }, 'init')
    const project = (await server.call('POST', routes.projects(), { path: repo.path, defaultBase: 'main' })).body.project
    worktreeId = (await server.call('GET', routes.project(project.id))).body.worktrees[0].id
  })
  afterEach(async () => {
    await server.close()
    repo.cleanup()
  })

  it('commits only the checked files and leaves the rest dirty', async () => {
    repo.write({ 'a.txt': 'a changed\n', 'b.txt': 'b changed\n', 'new.txt': 'new\n' })

    const staged = (await server.call('POST', routes.stage(worktreeId), { stage: ['a.txt', 'new.txt'] })).body as ChangesResponse
    expect(staged.files.filter((file) => file.staged === 'staged').map((file) => file.path)).toEqual(['a.txt', 'new.txt'])
    expect(staged.files.find((file) => file.path === 'b.txt')?.staged).toBe('unstaged')

    const created = await server.call('POST', routes.commitChanges(worktreeId), { summary: 'partial', description: 'body text' })
    expect(created.status).toBe(201)
    expect(created.body.commit.subject).toBe('partial')

    expect((await repo.git('show', '--stat', '--format=', 'HEAD')).trim().split('\n').slice(0, 2).join(' ')).toContain('a.txt')
    expect(await repo.git('show', '--name-only', '--format=', 'HEAD')).toBe('a.txt\nnew.txt')
    expect(await repo.git('log', '-1', '--format=%B')).toBe('partial\n\nbody text\n')
    // The file that was never checked is still there, still dirty.
    expect(await fileNamed('b.txt')).toMatchObject({ status: 'M', staged: 'unstaged' })
  })

  it('keeps staging done outside Canopy, and commits it', async () => {
    repo.write({ 'a.txt': 'a changed\n', 'b.txt': 'b changed\n' })
    await repo.git('add', 'a.txt')

    // The checkbox reflects the index rather than a selection Canopy keeps beside it.
    expect(await fileNamed('a.txt')).toMatchObject({ staged: 'staged' })
    expect(await fileNamed('b.txt')).toMatchObject({ staged: 'unstaged' })

    await server.call('POST', routes.commitChanges(worktreeId), { summary: 'from the terminal' })
    expect(await repo.git('show', '--name-only', '--format=', 'HEAD')).toBe('a.txt')
  })

  it('shows a file staged and then reverted on disk, which a HEAD→worktree diff cannot see', async () => {
    repo.write({ 'a.txt': 'staged content\n' })
    await repo.git('add', 'a.txt')
    repo.write({ 'a.txt': 'a\n' })

    expect(await repo.git('diff', '--numstat', 'HEAD', '--', 'a.txt')).toBe('')
    // It is in the index, so it would be committed; leaving it out of the list would commit it unseen.
    expect(await fileNamed('a.txt')).toMatchObject({ staged: 'partial' })
  })

  it('stages a chosen subset of hunks and leaves the others in the working tree', async () => {
    repo.write({ 'big.txt': EDITED })
    const before = await hunks('big.txt')
    expect(before.staged).toEqual([])
    expect(before.representable).toBe(true)
    expect(before.patchHash).toHaveLength(hashPatch('x').length)

    await server.call('POST', routes.stageHunks(worktreeId), { path: 'big.txt', hunks: [0, 2], patchHash: before.patchHash })

    const after = await hunks('big.txt')
    expect(after.staged).toEqual([0, 2])
    expect(after.partial).toEqual([])
    expect(await fileNamed('big.txt')).toMatchObject({ staged: 'partial' })

    await server.call('POST', routes.commitChanges(worktreeId), { summary: 'two of three' })
    // The committed blob has the first and last edits and not the middle one.
    const committed = await repo.git('show', 'HEAD:big.txt')
    expect(committed).toBe(lines((line) => (line === 1 || line === 30 ? `EDITED ${line}` : `line ${line}`)).trimEnd())
    // …and the middle edit is still sitting in the working tree.
    expect(await repo.git('diff', '--numstat', '--', 'big.txt')).toBe('1\t1\tbig.txt')
  })

  it('stages part of an untracked file, which has no HEAD blob to build on', async () => {
    repo.write({ 'fresh.txt': 'one\ntwo\nthree\n' })
    const state = await hunks('fresh.txt')
    expect(state.staged).toEqual([])

    await server.call('POST', routes.stageHunks(worktreeId), { path: 'fresh.txt', hunks: [0], patchHash: state.patchHash })
    await server.call('POST', routes.commitChanges(worktreeId), { summary: 'part of a new file' })
    expect(await repo.git('show', 'HEAD:fresh.txt')).toBe('one\ntwo\nthree')
  })

  it('refuses hunk picks made against a patch that has since changed', async () => {
    repo.write({ 'big.txt': EDITED })
    const stale = await hunks('big.txt')
    repo.write({ 'big.txt': lines((line) => (line === 1 ? 'something else' : `line ${line}`)) })

    const response = await server.call('POST', routes.stageHunks(worktreeId), { path: 'big.txt', hunks: [0], patchHash: stale.patchHash })
    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('stale_patch')
  })

  it('refuses to rebuild a file whose staged content these hunks cannot express', async () => {
    // Stage one thing, then edit the same line to another: the staged change is no longer one of
    // the working tree's changes, so rebuilding from HEAD would throw it away.
    repo.write({ 'a.txt': 'staged version\n' })
    await repo.git('add', 'a.txt')
    repo.write({ 'a.txt': 'worktree version\n' })

    const state = await hunks('a.txt')
    expect(state.representable).toBe(false)
    const response = await server.call('POST', routes.stageHunks(worktreeId), { path: 'a.txt', hunks: [0], patchHash: state.patchHash })
    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('not_representable')
    // The staged version is untouched.
    expect(await repo.git('show', ':a.txt')).toBe('staged version')
  })

  it('unchecking a file takes it back out of the index', async () => {
    repo.write({ 'a.txt': 'a changed\n' })
    await server.call('POST', routes.stage(worktreeId), { stage: ['a.txt'] })
    const back = (await server.call('POST', routes.stage(worktreeId), { unstage: ['a.txt'] })).body as ChangesResponse
    expect(back.files.find((file) => file.path === 'a.txt')?.staged).toBe('unstaged')
    expect(await repo.git('diff', '--cached', '--name-only')).toBe('')
  })

  it('refuses to commit when nothing is staged', async () => {
    repo.write({ 'a.txt': 'a changed\n' })
    const response = await server.call('POST', routes.commitChanges(worktreeId), { summary: 'nothing' })
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('nothing_staged')
  })

  it('hides a path locally without touching .gitignore, and puts it back', async () => {
    repo.write({ 'secret.env': 'token\n' })
    expect((await changes()).files.map((file) => file.path)).toContain('secret.env')

    const hidden = (await server.call('POST', routes.exclude(worktreeId), { paths: ['secret.env'], how: 'exclude' })).body.hidden
    expect(hidden).toEqual([{ path: 'secret.env', how: 'exclude' }])
    expect((await changes()).files.map((file) => file.path)).not.toContain('secret.env')
    // The whole point: the committed ignore file is untouched.
    expect(await repo.git('status', '--porcelain')).not.toContain('.gitignore')

    await server.call('POST', routes.unhide(worktreeId), { paths: ['secret.env'] })
    expect((await changes()).files.map((file) => file.path)).toContain('secret.env')
  })

  it('hides local edits to a tracked file with skip-worktree, and lists it as hidden', async () => {
    repo.write({ 'a.txt': 'local only\n' })
    await server.call('POST', routes.exclude(worktreeId), { paths: ['a.txt'], how: 'skipWorktree' })

    expect((await changes()).files.map((file) => file.path)).not.toContain('a.txt')
    expect((await server.call('GET', routes.hidden(worktreeId))).body.hidden).toEqual([{ path: 'a.txt', how: 'skipWorktree' }])

    await server.call('POST', routes.unhide(worktreeId), { paths: ['a.txt'] })
    expect((await changes()).files.map((file) => file.path)).toContain('a.txt')
  })

  it('stops tracking a file while leaving it on disk, as a staged deletion', async () => {
    await server.call('POST', routes.exclude(worktreeId), { paths: ['b.txt'], how: 'untrack' })
    // Not a hiding mechanism at all: it is a repo change that the next commit carries.
    expect(await fileNamed('b.txt')).toMatchObject({ status: 'D', staged: 'staged' })

    await server.call('POST', routes.commitChanges(worktreeId), { summary: 'stop tracking b' })
    expect(await repo.git('ls-files')).not.toContain('b.txt')
    expect((await changes()).files.map((file) => file.path)).toContain('b.txt')
  })

  it('refuses to stage individual paths while a merge is unresolved', async () => {
    await repo.git('checkout', '-q', '-b', 'other')
    await repo.commit({ 'a.txt': 'from other\n' }, 'other side')
    await repo.git('checkout', '-q', 'main')
    await repo.commit({ 'a.txt': 'from main\n' }, 'main side')
    await repo.git('merge', 'other').catch(() => undefined)

    const listed = await changes()
    expect(listed.operation).toBe('merge')
    expect(listed.files.find((file) => file.path === 'a.txt')?.conflicted).toBe(true)

    const response = await server.call('POST', routes.stage(worktreeId), { stage: ['a.txt'] })
    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('operation_in_progress')
  })
})
