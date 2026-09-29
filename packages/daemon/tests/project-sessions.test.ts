import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { routes, type AgentSessionSummary } from '@canopy/shared'

import { claudeProjectKey } from '../src/agents/checkouts'
import { createFixtureRepo, type FixtureRepo } from './helpers/fixture-repo'
import { createTestServer, type TestServer } from './helpers/test-server'

/** Creation returns as soon as the row exists; the checkout lands a moment later. */
async function settled(server: TestServer, id: string): Promise<{ id: string; path: string }> {
  for (let i = 0; i < 200; i++) {
    const { body } = await server.call('GET', routes.worktree(id))
    const state = body.worktree.environment.state
    if (state !== 'creating' && state !== 'provisioning') return body.worktree
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('worktree never left creating')
}

/** One session per directory, named after it, the way a provider files them. */
const sessionIn = (cwd: string, updatedAt: number): AgentSessionSummary => ({ provider: 'claude', sessionId: `s-${cwd.split('/').pop()}`, title: `ran in ${cwd}`, cwd, updatedAt })

/** A Claude Code store directory holding one session that recorded `cwd`. */
function storeSession(server: TestServer, cwd: string): void {
  const dir = join(server.home, 'claude-projects', claudeProjectKey(cwd))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'abc.jsonl'), `{"type":"mode","mode":"normal"}\n{"type":"user","cwd":${JSON.stringify(cwd)},"sessionId":"abc"}\n`)
}

describe('sessions across a project’s checkouts', () => {
  let server: TestServer
  let repo: FixtureRepo
  let projectId: string
  let mainId: string
  const byCwd = new Map<string, AgentSessionSummary[]>()

  beforeEach(async () => {
    server = await createTestServer()
    repo = await createFixtureRepo()
    await repo.commit({ 'a.txt': 'one\n' }, 'init')
    const { body } = await server.call('POST', routes.projects(), { path: repo.path })
    projectId = body.project.id
    mainId = (await server.call('GET', routes.project(projectId))).body.worktrees[0].id
    byCwd.clear()
    byCwd.set(repo.path, [sessionIn(repo.path, 1)])
    server.agent.listSessions = async (cwd: string) => byCwd.get(cwd) ?? []
  })
  afterEach(async () => {
    await server.close()
    repo.cleanup()
  })

  const list = async (worktreeId: string): Promise<AgentSessionSummary[]> => (await server.call('GET', routes.agentSessions(worktreeId))).body.sessions

  async function worktree(name: string): Promise<{ id: string; path: string }> {
    const created = await server.call('POST', routes.projectWorktrees(projectId), { name, branch: { mode: 'new', name: `feat/${name}`, base: 'main' } })
    return settled(server, created.body.worktree.id)
  }

  it('keeps a removed worktree’s sessions in the main checkout, continued from main', async () => {
    const gone = await worktree('gone')
    byCwd.set(gone.path, [sessionIn(gone.path, 5)])
    expect((await server.call('DELETE', `${routes.worktree(gone.id)}?force=true`)).status).toBe(200)

    const listed = await list(mainId)
    expect(listed.map((s) => [s.sessionId, s.origin?.kind ?? 'own'])).toEqual([
      ['s-' + repo.path.split('/').pop(), 'own'],
      ['s-gone', 'removed']
    ])
    expect(listed[1]?.origin).toMatchObject({ name: 'gone', path: gone.path, branch: 'feat/gone', runIn: repo.path })
  })

  it('lists live worktrees’ sessions under main, and main’s under each worktree', async () => {
    const live = await worktree('live')
    byCwd.set(live.path, [sessionIn(live.path, 7)])

    const fromMain = await list(mainId)
    expect(fromMain.find((s) => s.sessionId === 's-live')?.origin).toMatchObject({ kind: 'worktree', name: 'live', worktreeId: live.id, runIn: live.path })

    const fromWorktree = await list(live.id)
    expect(fromWorktree.map((s) => [s.sessionId, s.origin?.kind ?? 'own'])).toEqual([
      ['s-live', 'own'],
      ['s-' + repo.path.split('/').pop(), 'main']
    ])
  })

  it('finds worktrees removed before Canopy recorded them, from Claude Code’s store', async () => {
    const old = join(repo.path, '.worktrees', 'old')
    storeSession(server, old)
    byCwd.set(old, [sessionIn(old, 3)])
    // Named like the project's paths, but a different repository: its cwd is not the project's.
    const neighbour = `${repo.path}-other`
    storeSession(server, neighbour)
    byCwd.set(neighbour, [sessionIn(neighbour, 4)])

    const listed = await list(mainId)
    expect(listed.map((s) => s.sessionId)).not.toContain('s-' + neighbour.split('/').pop())
    expect(listed.find((s) => s.sessionId === 's-old')?.origin).toMatchObject({ kind: 'removed', name: 'old', path: old, runIn: repo.path })
  })

  it('refuses to run a turn in a directory that is gone', async () => {
    const response = await server.call('POST', routes.messages('claude', 's1'), { text: 'hi', cwd: join(repo.path, 'nope') })
    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('checkout_gone')
  })
})
