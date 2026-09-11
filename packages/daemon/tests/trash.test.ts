import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { routes } from '@canopy/shared'

import { createFixtureRepo, type FixtureRepo } from './helpers/fixture-repo'
import { createTestServer, type TestServer } from './helpers/test-server'

async function settled(server: TestServer, id: string) {
  for (let i = 0; i < 200; i++) {
    const { body } = await server.call('GET', routes.worktree(id))
    const state = body.worktree.environment.state
    if (state !== 'creating' && state !== 'provisioning') return body.worktree
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('worktree never left creating')
}

describe('trash', () => {
  let server: TestServer
  let repo: FixtureRepo
  let projectId: string

  beforeEach(async () => {
    server = await createTestServer()
    repo = await createFixtureRepo()
    await repo.commit({ 'a.txt': 'one\n', 'doomed.txt': 'delete me\n' }, 'init')
    projectId = (await server.call('POST', routes.projects(), { path: repo.path })).body.project.id
  })
  afterEach(async () => {
    await server.close()
    repo.cleanup()
  })

  /** A worktree with one file changed, one added and one deleted, then destroyed. */
  const destroyDirty = async (name: string) => {
    const wt = await settled(server, (await server.call('POST', routes.projectWorktrees(projectId), { name, branch: { mode: 'new', name: `feat/${name}`, base: 'main' } })).body.worktree.id)
    writeFileSync(join(wt.path, 'a.txt'), 'edited\n')
    writeFileSync(join(wt.path, 'added.ts'), 'export const added = 1\n')
    rmSync(join(wt.path, 'doomed.txt'))
    await server.call('DELETE', `${routes.worktree(wt.id)}?force=true&deleteBranch=true`)
    return wt
  }

  it('lists what a destroy left behind, described by the worktree it came from', async () => {
    const wt = await destroyDirty('spike')

    const { body } = await server.call('GET', routes.projectTrash(projectId))
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0]).toMatchObject({ name: 'spike', branch: 'feat/spike', path: wt.path, files: 3 })
    expect(body.entries[0].destroyedAt).toBeGreaterThan(0)
  })

  it('is empty when a destroy had nothing to save', async () => {
    const clean = await settled(server, (await server.call('POST', routes.projectWorktrees(projectId), { name: 'tidy', branch: { mode: 'new', name: 'feat/tidy', base: 'main' } })).body.worktree.id)
    await server.call('DELETE', routes.worktree(clean.id))
    expect((await server.call('GET', routes.projectTrash(projectId))).body.entries).toEqual([])
  })

  it('restores the worktree as it was, with the work still uncommitted', async () => {
    const wt = await destroyDirty('spike')
    const entry = (await server.call('GET', routes.projectTrash(projectId))).body.entries[0]

    const { status, body } = await server.call('POST', routes.trashRestore(projectId, entry.id))
    expect(status).toBe(200)
    expect(body.worktree).toMatchObject({ name: 'spike', branch: 'feat/spike', path: wt.path })

    // Every kind of change is back: the edit, the new file, and the deletion.
    expect(readFileSync(join(wt.path, 'a.txt'), 'utf8')).toBe('edited\n')
    expect(readFileSync(join(wt.path, 'added.ts'), 'utf8')).toBe('export const added = 1\n')
    expect(existsSync(join(wt.path, 'doomed.txt'))).toBe(false)

    // Uncommitted, as it was when it was lost — restoring must not invent a commit.
    expect(body.worktree.status.dirtyTotal).toBeGreaterThan(0)
    expect((await repo.git('log', '--oneline', 'feat/spike')).trim().split('\n')).toHaveLength(1)

    // Restored means out of the trash.
    expect((await server.call('GET', routes.projectTrash(projectId))).body.entries).toEqual([])
  })

  it('refuses to restore over a path that is a worktree again', async () => {
    await destroyDirty('spike')
    const entry = (await server.call('GET', routes.projectTrash(projectId))).body.entries[0]
    await settled(server, (await server.call('POST', routes.projectWorktrees(projectId), { name: 'spike', branch: { mode: 'new', name: 'feat/spike-again', base: 'main' } })).body.worktree.id)

    const { status, body } = await server.call('POST', routes.trashRestore(projectId, entry.id))
    expect(status).toBe(409)
    expect(body.error.code).toBe('path_taken')
    // Nothing was thrown away by the refusal.
    expect((await server.call('GET', routes.projectTrash(projectId))).body.entries).toHaveLength(1)
  })

  it('purges an entry for good', async () => {
    await destroyDirty('spike')
    const entry = (await server.call('GET', routes.projectTrash(projectId))).body.entries[0]

    expect((await server.call('DELETE', routes.trashEntry(projectId, entry.id))).status).toBe(204)
    expect((await server.call('GET', routes.projectTrash(projectId))).body.entries).toEqual([])
    await expect(repo.git('rev-parse', '--verify', entry.ref)).rejects.toThrow()
  })
})
