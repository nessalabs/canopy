import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AgentSessionSummary } from '@canopy/shared'

import { RECENT_HOOK_MS, statusOf } from '../src/agents/sessions'
import { createFixtureRepo, type FixtureRepo } from './helpers/fixture-repo'
import { createTestServer, type TestServer } from './helpers/test-server'

const hook = (sessionId: string, cwd: string, tool: string, input: unknown, event: 'PreToolUse' | 'PostToolUse' = 'PreToolUse') => ({
  hook_event_name: event,
  session_id: sessionId,
  cwd,
  tool_name: tool,
  tool_use_id: `tu-${Math.random().toString(36).slice(2)}`,
  tool_input: input
})

describe('sessions that work in a worktree from elsewhere', () => {
  let server: TestServer
  let repo: FixtureRepo
  let worktreeId: string
  let elsewhere: string

  beforeEach(async () => {
    server = await createTestServer()
    repo = await createFixtureRepo()
    await repo.commit({ 'src/a.ts': 'export const a = 1\n' }, 'init')
    const { body } = await server.call('POST', '/api/v1/projects', { path: repo.path })
    const project = await server.call('GET', `/api/v1/projects/${body.project.id}`)
    worktreeId = project.body.worktrees[0].id
    elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'canopy-elsewhere-')))
    // The fake provider lists only its fixture session, whatever the cwd.
    server.agent.sessions = [{ provider: 'claude', sessionId: 's1', title: 'fixture session', updatedAt: 1, cwd: repo.path }]
  })
  afterEach(async () => {
    await server.close()
    repo.cleanup()
    rmSync(elsewhere, { recursive: true, force: true })
  })

  const sessions = async (): Promise<AgentSessionSummary[]> => (await server.call('GET', `/api/v1/worktrees/${worktreeId}/agent/sessions`)).body.sessions

  it('lists a session whose cwd is elsewhere once its hooks edit a file here', async () => {
    expect((await sessions()).map((s) => s.sessionId)).toEqual(['s1'])

    const edit = hook('visitor', elsewhere, 'Edit', { file_path: join(repo.path, 'src/a.ts'), old_string: '1', new_string: '2' })
    expect((await server.call('POST', '/api/v1/hooks/claude', edit)).status).toBe(204)

    const listed = await sessions()
    expect(listed.map((s) => [s.sessionId, s.visiting ?? false])).toEqual([
      ['visitor', true],
      ['s1', false]
    ])
    const visitor = listed[0] as AgentSessionSummary
    expect(visitor.cwd).toBe(elsewhere)
    // The provider did not know it (the fake has no lookup), so it is named by id and dated by the hook.
    expect(visitor.title).toBe('visitor')
    expect(visitor.status).toBe('busy')
  })

  it('takes a shell command that names the worktree as working here, and a stranger as nothing', async () => {
    await server.call('POST', '/api/v1/hooks/claude', hook('shell', elsewhere, 'Bash', { command: `cd ${repo.path} && npm test` }))
    await server.call('POST', '/api/v1/hooks/claude', hook('stranger', elsewhere, 'Bash', { command: `ls ${repo.path}-sibling` }))
    await server.call('POST', '/api/v1/hooks/claude', hook('nowhere', elsewhere, 'Edit', { file_path: join(elsewhere, 'x.ts') }))
    expect((await sessions()).map((s) => s.sessionId)).toEqual(['shell', 's1'])
  })

  it('does not list a session twice for working in its own checkout', async () => {
    await server.call('POST', '/api/v1/hooks/claude', hook('s1', repo.path, 'Edit', { file_path: join(repo.path, 'src/a.ts') }))
    await server.call('POST', '/api/v1/hooks/claude', hook('s1', join(repo.path, 'src'), 'Bash', { command: 'echo hi' }))
    const listed = await sessions()
    expect(listed.map((s) => s.sessionId)).toEqual(['s1'])
    // Its own hooks still date it: a fixture session from 1970 is busy right now.
    expect(listed[0]?.status).toBe('busy')
    expect(listed[0]?.visiting).toBeUndefined()
  })

  it('fills in what the provider knows about a visitor', async () => {
    server.agent.describeSession = async (sessionId, cwd) => (sessionId === 'visitor' ? { provider: 'claude', sessionId, title: 'Fix the flaky test', cwd, updatedAt: 5, preview: 'fix it' } : undefined)
    await server.call('POST', '/api/v1/hooks/claude', hook('visitor', elsewhere, 'Write', { file_path: join(repo.path, 'src/b.ts'), content: '' }))
    const [visitor] = await sessions()
    expect(visitor).toMatchObject({ sessionId: 'visitor', title: 'Fix the flaky test', preview: 'fix it', cwd: elsewhere, visiting: true })
    expect(visitor?.updatedAt).toBeGreaterThan(5)
  })

  it('announces a session the first time it appears in a worktree, not on every call', async () => {
    const seen: string[] = []
    const stop = server.events.subscribe((event) => {
      if (event.type === 'agent-sessions-changed') seen.push(event.worktreeId)
    })
    const edit = () => hook('visitor', elsewhere, 'Edit', { file_path: join(repo.path, 'src/a.ts') })
    await server.call('POST', '/api/v1/hooks/claude', edit())
    await server.call('POST', '/api/v1/hooks/claude', edit())
    await server.call('POST', '/api/v1/hooks/claude', edit())
    stop()
    expect(seen).toEqual([worktreeId])
  })
})

describe('what a session is doing', () => {
  const session: AgentSessionSummary = { provider: 'claude', sessionId: 'x', title: 'x', updatedAt: 0 }
  const live = (status?: string) => ({ pid: 1, sessionId: 'x', socketPath: '/s', status })
  const at = 1_000_000

  it('believes the terminal first', () => {
    expect(statusOf(session, live('busy'), undefined, at)).toBe('busy')
    expect(statusOf(session, live('idle'), undefined, at)).toBe('idle')
    expect(statusOf(session, live(), undefined, at)).toBe('idle')
  })

  it('takes a recent hook as a running turn, even with no terminal', () => {
    expect(statusOf(session, undefined, at - RECENT_HOOK_MS + 1, at)).toBe('busy')
    expect(statusOf(session, undefined, at - RECENT_HOOK_MS, at)).toBeUndefined()
    expect(statusOf(session, live('idle'), at - 1, at)).toBe('busy')
  })

  it('says nothing about a session nothing is watching', () => {
    expect(statusOf(session, undefined, undefined, at)).toBeUndefined()
    expect(statusOf({ ...session, provider: 'codex', active: true }, undefined, undefined, at)).toBe('busy')
  })
})
