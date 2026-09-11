import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { execa } from 'execa'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { routes } from '@canopy/shared'

import { createFixtureRepo, type FixtureRepo } from './helpers/fixture-repo'
import { createTestServer, type TestServer } from './helpers/test-server'

/** Creation returns as soon as the row exists; the checkout lands a moment later. */
async function settled(server: TestServer, id: string) {
  for (let i = 0; i < 200; i++) {
    const { body } = await server.call('GET', routes.worktree(id))
    const state = body.worktree.environment.state
    if (state !== 'creating' && state !== 'provisioning') return body.worktree
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('worktree never left creating')
}

describe('worktrees', () => {
  let server: TestServer
  let repo: FixtureRepo
  let projectId: string
  beforeEach(async () => {
    server = await createTestServer()
    repo = await createFixtureRepo()
    await repo.commit({ 'a.txt': 'one\n' }, 'init')
    await repo.branch('existing')
    projectId = (await server.call('POST', routes.projects(), { path: repo.path })).body.project.id
  })
  afterEach(async () => {
    await server.close()
    repo.cleanup()
  })

  it('discovers the primary checkout as main', async () => {
    const { body } = await server.call('GET', routes.worktrees())
    expect(body.worktrees).toHaveLength(1)
    expect(body.worktrees[0]).toMatchObject({ isMain: true, branch: 'main', state: 'clean', managed: false })
    expect(body.worktrees[0].status.lastCommit.subject).toBe('init')
  })

  it('creates on a new branch and on an existing one, then destroys', async () => {
    const fresh = await server.call('POST', routes.projectWorktrees(projectId), { name: 'feat-x', branch: { mode: 'new', name: 'feat/x', base: 'main' } })
    expect(fresh.status).toBe(201)
    expect(fresh.body.worktree).toMatchObject({ name: 'feat-x', branch: 'feat/x', managed: true, isMain: false, baseBranch: 'main' })
    expect(fresh.body.worktree.environment.state).toBe('creating')
    const landed = await settled(server, fresh.body.worktree.id)
    expect(existsSync(landed.path)).toBe(true)
    // No canopy.yaml in this repo: the worktree exists but has no environment to run.
    expect(landed.environment.state).toBe('none')
    expect(landed.environment.provisioning.steps[0]).toMatchObject({ name: 'create-worktree', status: 'done' })

    const reused = await server.call('POST', routes.projectWorktrees(projectId), { name: 'exist', branch: { mode: 'existing', name: 'existing' } })
    expect(reused.body.worktree.branch).toBe('existing')
    await settled(server, reused.body.worktree.id)
    expect((await server.call('GET', routes.worktrees())).body.worktrees).toHaveLength(3)

    expect((await server.call('DELETE', routes.worktree(fresh.body.worktree.id))).status).toBe(204)
    expect(existsSync(fresh.body.worktree.path)).toBe(false)
    expect((await server.call('DELETE', routes.worktree(reused.body.worktree.id))).status).toBe(204)
  })

  it('refuses to destroy dirty worktrees unless forced, and never the main checkout', async () => {
    const created = await settled(server, (await server.call('POST', routes.projectWorktrees(projectId), { name: 'dirty', branch: { mode: 'new', name: 'dirty', base: 'main' } })).body.worktree.id)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(`${created.path}/a.txt`, 'changed\n')

    const refused = await server.call('DELETE', routes.worktree(created.id))
    expect(refused.status).toBe(409)
    expect(refused.body.error.code).toBe('worktree_dirty')
    expect((await server.call('GET', routes.worktree(created.id))).body.worktree.state).toBe('dirty')
    expect((await server.call('DELETE', `${routes.worktree(created.id)}?force=true`)).status).toBe(204)

    const main = (await server.call('GET', routes.worktrees())).body.worktrees[0]
    expect((await server.call('DELETE', routes.worktree(main.id))).body.error.code).toBe('cannot_destroy_main')
  })

  describe('merged', () => {
    const create = async (name: string, branch: string) =>
      settled(server, (await server.call('POST', routes.projectWorktrees(projectId), { name, branch: { mode: 'new', name: branch, base: 'main' } })).body.worktree.id)
    const commitIn = async (path: string, file: string): Promise<void> => {
      writeFileSync(join(path, file), `${file}\n`)
      await execa('git', ['add', '-A'], { cwd: path })
      await execa('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-q', '-m', file], { cwd: path })
    }
    const mergedOf = async (id: string): Promise<boolean | null> => (await server.call('GET', routes.worktree(id))).body.worktree.status.merged

    it('says nothing for the main checkout or a branch still sitting on the base tip', async () => {
      expect((await server.call('GET', routes.worktrees())).body.worktrees[0].status.merged).toBeNull()
      const fresh = await create('fresh', 'fresh')
      expect(await mergedOf(fresh.id)).toBeNull()
      // Once the base moves past it the branch is behind, and behind with nothing of its own is merged.
      await repo.commit({ 'b.txt': 'two\n' }, 'base moves')
      expect(await mergedOf(fresh.id)).toBe(true)
    })

    it('tells a merged, squash-merged and unmerged branch apart', async () => {
      const merged = await create('merged', 'feat/merged')
      const squashed = await create('squashed', 'feat/squashed')
      const open = await create('open', 'feat/open')
      await commitIn(merged.path, 'm.txt')
      await commitIn(squashed.path, 's1.txt')
      await commitIn(squashed.path, 's2.txt')
      await commitIn(open.path, 'o.txt')
      expect(await mergedOf(merged.id)).toBe(false)

      await repo.git('merge', '-q', '--no-ff', '-m', 'merge', 'feat/merged')
      await repo.git('merge', '-q', '--squash', 'feat/squashed')
      await repo.git('commit', '-q', '-m', 'squash')
      expect(await mergedOf(merged.id)).toBe(true)
      expect(await mergedOf(squashed.id)).toBe(true)
      expect(await mergedOf(open.id)).toBe(false)

      // A new commit on the branch invalidates the cached answer.
      await commitIn(squashed.path, 's3.txt')
      expect(await mergedOf(squashed.id)).toBe(false)
    })

    it('counts a branch that only origin/main has as merged', async () => {
      const remote = mkdtempSync(join(tmpdir(), 'canopy-remote-'))
      try {
        await execa('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: remote })
        await repo.git('remote', 'add', 'origin', remote)
        const wt = await create('remote-only', 'feat/remote')
        await commitIn(wt.path, 'r.txt')
        const before = (await repo.git('rev-parse', 'HEAD')).trim()
        await repo.git('merge', '-q', '--no-ff', '-m', 'merge', 'feat/remote')
        await repo.git('push', '-q', 'origin', 'main')
        await repo.git('reset', '-q', '--hard', before)
        expect(await mergedOf(wt.id)).toBe(true)
      } finally {
        rmSync(remote, { recursive: true, force: true })
      }
    })
  })

  describe('merge', () => {
    const create = async (name: string, branch: string) =>
      settled(server, (await server.call('POST', routes.projectWorktrees(projectId), { name, branch: { mode: 'new', name: branch, base: 'main' } })).body.worktree.id)
    const commitIn = async (path: string, file: string, content = `${file}\n`): Promise<void> => {
      writeFileSync(join(path, file), content)
      await execa('git', ['add', '-A'], { cwd: path })
      await execa('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-q', '-m', file], { cwd: path })
    }
    const mainSubjects = async (): Promise<string[]> => (await repo.git('log', '--format=%s', 'main')).split('\n').filter(Boolean)

    it('lands a branch with a merge commit, a squash, or a fast-forward, in the checkout that has main', async () => {
      const wt = await create('feat', 'feat/one')
      await commitIn(wt.path, 'one.txt')
      await commitIn(wt.path, 'two.txt')

      const squashed = await server.call('POST', routes.merge(wt.id), { strategy: 'squash', message: 'Land feat/one' })
      expect(squashed.status).toBe(200)
      expect(squashed.body).toMatchObject({ into: 'main', strategy: 'squash', checkout: repo.path })
      expect(await mainSubjects()).toEqual(['Land feat/one', 'init'])
      expect((await server.call('GET', routes.worktree(wt.id))).body.worktree.status.merged).toBe(true)

      await commitIn(wt.path, 'three.txt')
      const merged = await server.call('POST', routes.merge(wt.id), { strategy: 'merge', message: 'Merge feat/one' })
      expect(merged.status).toBe(200)
      expect((await mainSubjects())[0]).toBe('Merge feat/one')
      expect((await repo.git('rev-list', '--parents', '-1', 'main')).trim().split(' ')).toHaveLength(3)

      const other = await create('ff', 'feat/ff')
      await commitIn(other.path, 'four.txt')
      const ff = await server.call('POST', routes.merge(other.id), { strategy: 'ff' })
      expect(ff.status).toBe(200)
      expect((await repo.git('rev-parse', 'main')).trim()).toBe(ff.body.sha)
      expect((await mainSubjects())[0]).toBe('four.txt')
    })

    it('refuses what cannot land and leaves main untouched', async () => {
      const wt = await create('clash', 'feat/clash')
      await commitIn(wt.path, 'a.txt', 'branch\n')
      await repo.commit({ 'a.txt': 'main\n' }, 'main edits a')
      const before = (await repo.git('rev-parse', 'main')).trim()

      const ff = await server.call('POST', routes.merge(wt.id), { strategy: 'ff' })
      expect(ff.status).toBe(409)
      expect(ff.body.error.code).toBe('not_fast_forward')

      const clash = await server.call('POST', routes.merge(wt.id), { strategy: 'merge' })
      expect(clash.status).toBe(409)
      expect(clash.body.error).toMatchObject({ code: 'merge_conflict', details: { files: ['a.txt'] } })
      expect((await repo.git('rev-parse', 'main')).trim()).toBe(before)
      expect(await repo.git('status', '--porcelain')).toBe('')

      const empty = await create('empty', 'feat/empty')
      expect((await server.call('POST', routes.merge(empty.id), {})).body.error.code).toBe('nothing_to_merge')

      repo.write({ 'b.txt': 'dirty\n' })
      await repo.git('add', 'b.txt')
      const dirty = await server.call('POST', routes.merge(wt.id), { strategy: 'squash', message: 'x' })
      expect(dirty.body.error.code).toBe('base_dirty')

      const main = (await server.call('GET', routes.worktrees())).body.worktrees[0]
      expect((await server.call('POST', routes.merge(main.id), {})).status).toBe(400)
    })
  })
})
