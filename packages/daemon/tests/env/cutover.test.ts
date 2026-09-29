/**
 * The cutover, end to end: a real canopyd, a real repository, a real `canopyd` binary, and a
 * worktree created and destroyed through the HTTP API the clients use.
 *
 * The other backend tests call `createWorktreeBackend` directly. This one goes through the
 * daemon, so it also proves the settings key, the provisioning step and the destroy path were
 * all rewired — the parts a unit test of the backend cannot see.
 */
import { existsSync, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createWorktreeBackend } from '../../src/env/worktree/backend'
import { createCanopyd } from '../../src/env/worktree/canopyd'
import { ApiError } from '../../src/lib/errors'
import { runGit } from '../../src/git/exec'
import { createFixtureRepo, type FixtureRepo } from '../helpers/fixture-repo'
import { createTestServer, type TestServer } from '../helpers/test-server'

/** The binary is optional; this test only runs where it is installed. */
const hasTool = (process.env['PATH'] ?? '').split(delimiter).some((dir) => dir.length > 0 && existsSync(join(dir, 'canopyd')))

describe.skipIf(!hasTool)('canopyd through the daemon', () => {
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

  it('reports canopyd in host info', async () => {
    const host = await server.call<{ canopyd: { available: boolean; version: string | null } }>('GET', '/api/v1/host')
    expect(host.status).toBe(200)
    expect(host.body.canopyd.available).toBe(true)
    expect(host.body.canopyd.version).toMatch(/^\d+\.\d+\.\d+/)
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

describe.skipIf(!hasTool)('canopyd provisioning through the daemon', () => {
  let server: TestServer
  let repo: FixtureRepo

  /** The shared registry the daemon points every `canopyd` call at. */
  const registry = (): Array<{ owner?: string; branch: string; name: string; port: number }> => {
    const path = join(server.home, 'ports.json')
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { allocations: [] }).allocations : []
  }

  beforeEach(async () => {
    server = await createTestServer({ worktreeBackend: createWorktreeBackend(runGit) })
    repo = await createFixtureRepo()
    await repo.commit(
      {
        '.gitignore': '.env\nport.txt\n.env.canopy\n',
        'canopy.yaml': 'version: 1\nports:\n  web: {}\nsetup:\n  - name: port\n    run: echo ${ports.web} > port.txt\nservices:\n  noop:\n    run: sleep 600\n    autostart: false\n'
      },
      'init'
    )
    repo.write({ '.env': 'FROM_PRIMARY=1\n' })
  })

  afterEach(async () => {
    await server.close()
    repo.cleanup()
  })

  it('copies, allocates in the shared registry and range, substitutes setup, and releases on destroy', async () => {
    const { body: registered } = await server.call<{ project: { id: string } }>('POST', '/api/v1/projects', { path: repo.path })
    const created = await server.call<{ worktree: { id: string; path: string } }>('POST', `/api/v1/projects/${registered.project.id}/worktrees`, {
      name: 'feature',
      branch: { mode: 'new', name: 'feat/provision', base: 'main' },
      autoStart: false
    })
    expect(created.status, created.text).toBeLessThan(300)
    const { id, path } = created.body.worktree

    let state = ''
    for (let i = 0; i < 200 && !['stopped', 'running', 'error', 'degraded'].includes(state); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      state = (await server.call<{ worktree: { environment: { state: string } } }>('GET', `/api/v1/worktrees/${id}`)).body.worktree.environment.state
    }
    const env = (await server.call<{ worktree: { environment: { stateReason: string | null; ports: Record<string, number>; copiedFiles: string[] } } }>('GET', `/api/v1/worktrees/${id}`)).body.worktree.environment
    expect(env.stateReason).toBeNull()

    // Copied by canopyd from the primary checkout.
    expect(env.copiedFiles).toEqual(['.env'])
    expect(readFileSync(join(path, '.env'), 'utf8')).toBe('FROM_PRIMARY=1\n')

    // Allocated in the daemon's range, in the daemon's registry, tagged with this repository.
    const port = env.ports['web']
    expect(port).toBeGreaterThanOrEqual(40000)
    expect(port).toBeLessThanOrEqual(44999)
    expect(registry()).toEqual([expect.objectContaining({ branch: 'feat/provision', name: 'web', port })])
    expect(registry()[0]?.owner).toBeTruthy()

    // `${ports.web}` reached the shell as the number, not as a bad substitution.
    expect(readFileSync(join(path, 'port.txt'), 'utf8').trim()).toBe(String(port))

    const destroyed = await server.call('DELETE', `/api/v1/worktrees/${id}?force=true`)
    expect(destroyed.status, destroyed.text).toBeLessThan(300)
    expect(registry()).toEqual([])
  })

  it('refuses to reserve a number another worktree holds', async () => {
    const canopyd = createCanopyd({ env: () => ({ CANOPYD_PORTS_FILE: join(server.home, 'ports.json'), CANOPYD_PORT_RANGE: '40000-44999' }) })
    await canopyd.reserve({ cwd: repo.path, branch: 'feat/one', ports: { 'db:main': 43210 } })
    const refused = await canopyd.reserve({ cwd: repo.path, branch: 'feat/two', ports: { 'db:main': 43210 } }).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(ApiError)
    expect((refused as ApiError).code).toBe('port_in_use')
    expect(await canopyd.releasePorts({ cwd: repo.path, branch: 'feat/one' })).toBe(1)
  })
})
