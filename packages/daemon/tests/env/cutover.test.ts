/**
 * The cutover, end to end: a real canopyd, a real repository, a real `canopywt` binary, and a
 * worktree created and destroyed through the HTTP API the clients use.
 *
 * The other backend tests call `createWorktreeBackend` directly. This one goes through the
 * daemon, so it also proves the settings key, the provisioning step and the destroy path were
 * all rewired — the parts a unit test of the backend cannot see.
 */
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createWorktreeBackend } from '../../src/env/worktree/backend'
import { runGit } from '../../src/git/exec'
import { createFixtureRepo, type FixtureRepo } from '../helpers/fixture-repo'
import { createTestServer, type TestServer } from '../helpers/test-server'

/** The binary is optional; this test only runs where it is installed. */
const hasTool = (process.env['PATH'] ?? '').split(delimiter).some((dir) => dir.length > 0 && existsSync(join(dir, 'canopywt')))

describe.skipIf(!hasTool)('canopywt through the daemon', () => {
  let server: TestServer
  let repo: FixtureRepo

  beforeEach(async () => {
    // The real binary, not the fallback: this is the integration under test.
    server = await createTestServer({ worktreeBackend: createWorktreeBackend(runGit) })
    repo = await createFixtureRepo()
    await repo.commit({ 'a.txt': 'one\n', 'canopy.yaml': 'version: 1\nservices:\n  noop:\n    run: sleep 600\n    autostart: false\n' }, 'init')
  })

  afterEach(async () => {
    await server.close()
    repo.cleanup()
  })

  it('reports canopywt in host info', async () => {
    const host = await server.call<{ canopywt: { available: boolean; version: string | null } }>('GET', '/api/v1/host')
    expect(host.status).toBe(200)
    expect(host.body.canopywt.available).toBe(true)
    expect(host.body.canopywt.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('defaults a project to creating worktrees with the tool', async () => {
    const { body: created } = await server.call<{ project: { id: string } }>('POST', '/api/v1/projects', { path: repo.path })
    const settings = await server.call<{ settings: { worktree: { tool: boolean; worktreePath: string } } }>('GET', `/api/v1/projects/${created.project.id}/settings`)
    expect(settings.body.settings.worktree.tool).toBe(true)
    expect(settings.body.settings.worktree.worktreePath).toContain('{{')
  })

  it('creates and destroys a worktree through the API', async () => {
    const { body: registered } = await server.call<{ project: { id: string } }>('POST', '/api/v1/projects', { path: repo.path })

    const created = await server.call<{ worktree: { id: string; path: string; branch: string } }>('POST', `/api/v1/projects/${registered.project.id}/worktrees`, {
      name: 'feature',
      branch: { mode: 'new', name: 'feat/cutover', base: 'main' },
      options: { autoStart: false }
    })
    expect(created.status, created.text).toBeLessThan(300)

    // Creation is provisioned in the background, so wait for the checkout to land.
    const path = created.body.worktree.path
    for (let i = 0; i < 100 && !existsSync(join(path, 'a.txt')); i += 1) await new Promise((resolve) => setTimeout(resolve, 50))
    expect(existsSync(join(path, 'a.txt'))).toBe(true)
    expect(await repo.git('branch', '--list', 'feat/cutover')).toContain('feat/cutover')

    const destroyed = await server.call('DELETE', `/api/v1/worktrees/${created.body.worktree.id}?force=true`)
    expect(destroyed.status, destroyed.text).toBeLessThan(300)
    expect(existsSync(path)).toBe(false)
    // The prune ran: no stale administrative directory is left to confuse the next create.
    expect(await repo.git('worktree', 'list')).not.toContain('feat-cutover')
  })
})
