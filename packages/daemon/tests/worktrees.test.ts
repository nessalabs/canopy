import { existsSync } from 'node:fs'

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
})
