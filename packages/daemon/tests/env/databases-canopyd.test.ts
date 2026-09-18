/**
 * SQLite forks made by `canopyd db`, end to end through the HTTP API.
 *
 * The thing this unlocks is the last clause of the supervisor choice: a service that refers to
 * `${db.main.url}` could only be run in-process, because canopyd could not resolve the reference.
 * With the fork made by canopyd it can, so such a worktree is supervised by `canopyd run` too.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { routes, type Worktree } from '@canopy/shared'

import { createWorktreeBackend } from '../../src/env/worktree/backend'
import { runGit } from '../../src/git/exec'
import { createFixtureRepo, type FixtureRepo } from '../helpers/fixture-repo'
import { createTestServer, type TestServer } from '../helpers/test-server'

const hasTool = (process.env['PATH'] ?? '').split(delimiter).some((dir) => dir.length > 0 && existsSync(join(dir, 'canopyd')))

const CANOPY_YAML = `version: 1
name: fixture
databases:
  main:
    adapter: sqlite
    source: data/seed.db
    env: DATABASE_URL
services:
  web:
    run: echo "$DSN" > seen.txt; sleep 600
    env: { DSN: "\${db.main.url}?mode=rwc" }
    restart: never
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

describe.skipIf(!hasTool)('sqlite forks through canopyd', () => {
  let server: TestServer
  let repo: FixtureRepo
  let projectId: string

  beforeEach(async () => {
    server = await createTestServer({ worktreeBackend: createWorktreeBackend(runGit) })
    repo = await createFixtureRepo()
    await repo.commit({ 'canopy.yaml': CANOPY_YAML, 'data/seed.db': 'seed-bytes', '.gitignore': 'seen.txt\n.env.canopy\n' }, 'init')
    projectId = (await server.call('POST', routes.projects(), { path: repo.path })).body.project.id
  })

  afterEach(async () => {
    await server.close()
    repo.cleanup()
  })

  it('forks with canopyd, runs the service under canopyd run, resets and removes the fork', async () => {
    const created = await server.call('POST', routes.projectWorktrees(projectId), { name: 'feat-db', branch: { mode: 'new', name: 'feat/db', base: 'main' }, autoStart: true })
    const id: string = created.body.worktree.id
    const worktree = await waitFor<Worktree>(
      async () => (await server.call('GET', routes.worktree(id))).body.worktree,
      (wt) => ['running', 'degraded', 'error'].includes(wt.environment.state)
    )
    const env = worktree.environment
    expect(env.stateReason).toBeNull()
    expect(env.state).toBe('running')

    const db = env.databases[0]
    expect(db).toMatchObject({ name: 'main', adapter: 'sqlite', status: 'ready', envKey: 'DATABASE_URL', forkedFrom: 'seed template' })
    expect(db?.detail['managed_by']).toBe('canopyd')
    const file = db?.detail['file'] as string
    expect(readFileSync(file, 'utf8')).toBe('seed-bytes')
    // canopyd keeps it with the worktree's state in the repository, not under the daemon's data root.
    expect(file.startsWith(server.home)).toBe(false)
    expect(db?.connectionUrl).toBe(`file:${file}`)
    expect(env.env.find((v) => v.key === 'DATABASE_URL')?.value).toBe(`file:${file}`)

    // The reference in the service's own env resolved, and it was canopyd that ran the service.
    const seen = await waitFor(async () => (existsSync(join(worktree.path, 'seen.txt')) ? readFileSync(join(worktree.path, 'seen.txt'), 'utf8').trim() : ''), (text) => text.length > 0)
    expect(seen).toBe(`file:${file}?mode=rwc`)
    const supervisorLog = (await server.call('GET', `${routes.serviceLogs(id, 'supervisor')}?limit=200`)).body
    expect(supervisorLog.lines.some((line: { text: string }) => line.text === 'canopyd run web')).toBe(true)
    // The env file canopyd wrote carries the fork too.
    expect(readFileSync(join(worktree.path, '.env.canopy'), 'utf8')).toContain(`DATABASE_URL=file:${file}`)

    // Work against the fork, then ask for a fresh one.
    writeFileSync(file, 'an afternoon of work')
    const reset = await server.call('POST', routes.databaseReset(id, 'main'), {})
    expect(reset.status, reset.text).toBeLessThan(300)
    expect(readFileSync(file, 'utf8')).toBe('seed-bytes')

    expect((await server.call('DELETE', `${routes.worktree(id)}?force=true`)).status).toBe(200)
    expect(existsSync(file)).toBe(false)
  }, 60_000)
})
