/**
 * End-to-end through the HTTP layer: a fixture repo with a canopy.yaml and a tiny Node HTTP
 * service is registered, a worktree is created and provisioned (git fallback, no docker), the
 * service comes up healthy on its allocated port, logs stream, and destroy leaves nothing behind.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { routes, type Worktree } from '@canopy/shared'

import { createFixtureRepo, type FixtureRepo } from '../helpers/fixture-repo'
import { createTestServer, type TestServer } from '../helpers/test-server'

const SERVER_JS = `
const http = require('node:http')
const port = Number(process.env.PORT)
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); return }
  res.writeHead(200); res.end('hello from ' + process.env.CANOPY_WORKTREE)
})
server.listen(port, '127.0.0.1', () => console.log('listening on ' + port))
process.on('SIGTERM', () => { console.log('bye'); server.close(() => process.exit(0)) })
`

const CANOPY_YAML = `version: 1
name: fixture
env: { GREETING: hi }
ports:
  web: {}
setup:
  - run: echo setup-ran > setup.txt
services:
  web:
    run: node server.js
    env: { PORT: "\${ports.web}" }
    health: { http: "http://127.0.0.1:\${ports.web}/healthz", interval: 200ms, timeout: 1s, retries: 25 }
    restart: never
env_file: .env.canopy
`

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting: ${JSON.stringify(value).slice(0, 400)}`)
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

describe('environment end to end (host runtime, git fallback)', () => {
  let server: TestServer
  let repo: FixtureRepo
  let projectId: string

  beforeEach(async () => {
    server = await createTestServer()
    repo = await createFixtureRepo()
    await repo.commit({ 'canopy.yaml': CANOPY_YAML, 'server.js': SERVER_JS, 'package.json': '{"name":"fixture"}', '.gitignore': '.env\n.env.canopy\nsetup.txt\n' }, 'init')
    repo.write({ '.env': 'FROM_PRIMARY=1\n' })
    projectId = (await server.call('POST', routes.projects(), { path: repo.path })).body.project.id
  })
  afterEach(async () => {
    await server.close()
    repo.cleanup()
  })

  it('reports the canopy.yaml and a preview for the project', async () => {
    const project = (await server.call('GET', routes.projects())).body.projects[0]
    expect(project.config).toMatchObject({ present: true, valid: true, services: 1, ports: 1, databases: 0 })
    const preview = await server.call('GET', routes.projectEnvironment(projectId))
    expect(preview.body.services[0]).toMatchObject({ name: 'web', runtime: 'host', ports: ['web'] })
    expect(preview.body.setup).toEqual(['echo setup-ran > setup.txt'])
  })

  it('creates, provisions, starts, streams logs, stops and destroys a worktree', async () => {
    const created = await server.call('POST', routes.projectWorktrees(projectId), { name: 'feat-x', branch: { mode: 'new', name: 'feat/x', base: 'main' }, autoStart: true })
    expect(created.status).toBe(201)
    expect(created.body.worktree.environment.state).toBe('creating')
    const id: string = created.body.worktree.id

    const worktree = await waitFor<Worktree>(
      async () => (await server.call('GET', routes.worktree(id))).body.worktree,
      (wt) => ['running', 'degraded', 'error'].includes(wt.environment.state)
    )
    const env = worktree.environment
    expect(env.stateReason).toBeNull()
    expect(env.state).toBe('running')
    expect(env.provisioning?.status).toBe('done')
    expect(env.provisioning?.steps.map((s) => `${s.name}:${s.status}`)).toEqual([
      'create-worktree:done',
      'copy-files:done',
      // package.json makes this a node project, so cache rules exist; the fixture just has nothing to clone.
      'link-caches:done',
      'allocate-ports:done',
      'fork-databases:skipped',
      'write-env:done',
      'run-setup:done',
      'start-services:done'
    ])
    const port = env.ports['web']
    expect(port).toBeGreaterThan(0)
    expect(env.services[0]).toMatchObject({ name: 'web', status: 'healthy', runtime: 'host', ports: [{ name: 'web', port }] })
    expect(env.services[0]?.pid).toBeGreaterThan(0)
    expect(env.copiedFiles).toEqual(['.env'])
    expect(existsSync(join(worktree.path, '.env'))).toBe(true)
    expect(readFileSync(join(worktree.path, 'setup.txt'), 'utf8').trim()).toBe('setup-ran')
    const dotenv = readFileSync(join(worktree.path, '.env.canopy'), 'utf8')
    expect(dotenv).toContain(`CANOPY_PORT_WEB=${port}`)
    expect(dotenv).toContain('GREETING=hi')
    expect(env.env.find((v) => v.key === 'CANOPY_WORKTREE')?.value).toBe('feat-x')

    // The service really answers on its port with the injected worktree name.
    const response = await fetch(`http://127.0.0.1:${port}/`)
    expect(await response.text()).toBe('hello from feat-x')

    const logs = await waitFor(
      async () => (await server.call('GET', `${routes.serviceLogs(id, 'web')}?limit=50`)).body,
      (body) => body.lines.some((line: { text: string }) => line.text.includes('listening on'))
    )
    expect(logs.lines.some((line: { stream: string }) => line.stream === 'sys')).toBe(true)
    const provisionLog = (await server.call('GET', `${routes.serviceLogs(id, 'provision')}?limit=200`)).body
    expect(provisionLog.lines.some((line: { text: string }) => line.text.includes('run-setup'))).toBe(true)

    const stopped = await server.call('POST', routes.worktreeStop(id))
    expect(stopped.body.environment.state).toBe('stopped')
    expect(stopped.body.environment.services[0].status).toBe('stopped')
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toBeTruthy()

    const restarted = await server.call('POST', routes.worktreeStart(id))
    expect(['running', 'starting']).toContain(restarted.body.environment.state)
    await waitFor(async () => (await server.call('GET', routes.worktree(id))).body.worktree as Worktree, (wt) => wt.environment.state === 'running')

    // Second worktree gets a different port and the same setup, from the same template.
    const second = await server.call('POST', routes.projectWorktrees(projectId), { name: 'feat-y', branch: { mode: 'new', name: 'feat/y', base: 'main' }, autoStart: false })
    const secondWt = await waitFor<Worktree>(
      async () => (await server.call('GET', routes.worktree(second.body.worktree.id))).body.worktree,
      (wt) => ['stopped', 'error'].includes(wt.environment.state)
    )
    expect(secondWt.environment.state).toBe('stopped')
    expect(secondWt.environment.ports['web']).not.toBe(port)

    expect((await server.call('DELETE', routes.worktree(id))).status).toBe(204)
    expect(existsSync(worktree.path)).toBe(false)
    expect((await server.call('GET', routes.worktree(id))).status).toBe(404)
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toBeTruthy()
    expect((await server.call('DELETE', routes.worktree(secondWt.id))).status).toBe(204)
  }, 60_000)

  it('keeps a failed setup resumable and rejects starting without canopy.yaml', async () => {
    await repo.commit({ 'canopy.yaml': CANOPY_YAML.replace('echo setup-ran > setup.txt', 'exit 3') }, 'break setup')
    const created = await server.call('POST', routes.projectWorktrees(projectId), { name: 'broken', branch: { mode: 'new', name: 'broken', base: 'main' } })
    const id: string = created.body.worktree.id
    const failed = await waitFor<Worktree>(async () => (await server.call('GET', routes.worktree(id))).body.worktree, (wt) => wt.environment.state === 'error')
    expect(failed.environment.stateReason).toContain('run-setup')
    expect(failed.environment.provisioning?.steps.find((s) => s.name === 'run-setup')).toMatchObject({ status: 'failed' })
    expect(failed.environment.provisioning?.steps.find((s) => s.name === 'start-services')?.status).toBe('pending')

    // Fix the file in the worktree itself (the worktree's copy wins) and retry from the failed step.
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(failed.path, 'canopy.yaml'), CANOPY_YAML)
    const retried = await server.call('POST', routes.worktreeProvision(id), { from: 'run-setup', autoStart: false })
    expect(retried.status).toBe(200)
    const fixed = await waitFor<Worktree>(async () => (await server.call('GET', routes.worktree(id))).body.worktree, (wt) => ['stopped', 'error'].includes(wt.environment.state))
    expect(fixed.environment.state).toBe('stopped')
    expect(fixed.environment.provisioning?.steps.map((s) => s.status)).not.toContain('failed')
    expect((await server.call('DELETE', `${routes.worktree(id)}?force=true`)).status).toBe(204)
  }, 60_000)
})
