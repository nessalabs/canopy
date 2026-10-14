import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { routes, type AgentSessionSummary, type AgentStreamEvent, type FleetAgent } from '@canopy/shared'
import type { AgentEvent, AgentEventPayload } from '@canopy/shared/agent-stream'

import { activityOf, listFleet, openAsks, type LiveState } from '../src/agents/fleet'
import type { WorktreeRow } from '../src/worktrees/service'
import { fakeEvent } from './helpers/fake-agent'
import { createFixtureRepo, type FixtureRepo } from './helpers/fixture-repo'
import { createTestServer, type TestServer } from './helpers/test-server'

const session = (sessionId: string, extra: Partial<AgentSessionSummary> = {}): AgentSessionSummary => ({ provider: 'claude', sessionId, title: sessionId, updatedAt: 1, ...extra })
const row = (id: string, project = 'p1'): WorktreeRow => ({ id, project_id: project, name: id, path: `/w/${id}`, branch: null, base_branch: null, is_main: 0, managed: 1, missing: 0, env_state: 'none' })
const idle: LiveState = { running: () => false, asks: () => [] }
const frame = (payload: AgentEventPayload): AgentStreamEvent => ({
  type: 'event',
  event: { id: `e${Math.random()}`, sessionId: 's', seq: 0, ts: null, agentPath: [], payload, raw: null } as unknown as AgentEvent
})
const asked = (requestId: string) => frame({ type: 'permission_requested', requestId, callId: requestId, toolName: 'Bash', input: { command: 'ls' }, reason: null, displayName: null, description: null })
const decided = (requestId: string) => frame({ type: 'permission_decided', requestId, behavior: 'allow' } as unknown as AgentEventPayload)

describe('openAsks', () => {
  it('keeps the asks no answer has come back for, in the order they were raised', () => {
    const open = openAsks([asked('a'), asked('b'), decided('a'), asked('c'), frame({ type: 'unknown' } as unknown as AgentEventPayload)])
    expect(open.map((ask) => (ask.payload as { requestId: string }).requestId)).toEqual(['b', 'c'])
  })
})

describe('activityOf', () => {
  it('ranks a parked permission ask over a running turn', () => {
    expect(activityOf(session('a', { running: true }), true)).toBe('approval')
    expect(activityOf(session('a', { status: 'busy' }), false)).toBe('running')
    expect(activityOf(session('a', { status: 'idle' }), false)).toBe('done')
    expect(activityOf(session('a'), false)).toBe('done')
  })
})

describe('listFleet', () => {
  const fleet = (lists: Record<string, AgentSessionSummary[]>, live = idle, gitAgent: Record<string, string[]> = {}) =>
    listFleet({
      worktrees: { present: () => Object.keys(lists).map((id) => row(id)) },
      sessions: { list: async (wt) => lists[wt.id] ?? [] },
      gitAgent: { sessions: (id) => (gitAgent[id] ?? []).map((sessionId) => ({ provider: 'claude' as const, sessionId, createdAt: 0 })) },
      live
    })

  it('files a visiting session under the checkout it started in, once', async () => {
    const agents = await fleet({ a: [session('s', { visiting: true })], b: [session('s')] })
    expect(agents.map((agent) => agent.worktreeId)).toEqual(['b'])
  })

  it("marks the Git Agent's sessions as Canopy's and the rest as the project's", async () => {
    const agents = await fleet({ a: [session('git'), session('mine')] }, idle, { a: ['git'] })
    expect(Object.fromEntries(agents.map((agent) => [agent.sessionId, agent.kind]))).toEqual({ git: 'canopy', mine: 'project' })
  })

  it("takes the daemon's own turns and parked asks into account, newest first", async () => {
    const ask = (asked('x') as { event: AgentEvent }).event
    const live: LiveState = { running: (_, sid) => sid === 'r', asks: (_, sid) => (sid === 'q' ? [ask] : []) }
    const agents = await fleet({ a: [session('r', { updatedAt: 1 }), session('q', { updatedAt: 3 }), session('d', { updatedAt: 2 })] }, live)
    expect(agents.map((agent) => [agent.sessionId, agent.activity, agent.asks.length])).toEqual([
      ['q', 'approval', 1],
      ['d', 'done', 0],
      ['r', 'running', 0]
    ])
  })

  it('leaves out a checkout whose listing fails', async () => {
    const agents = await listFleet({
      worktrees: { present: () => [row('a'), row('b')] },
      sessions: { list: async (wt) => (wt.id === 'a' ? Promise.reject(new Error('gone')) : [session('s')]) },
      gitAgent: { sessions: () => [] },
      live: idle
    })
    expect(agents.map((agent) => agent.worktreeId)).toEqual(['b'])
  })
})

describe('GET /agents/fleet', () => {
  let server: TestServer
  let repo: FixtureRepo
  beforeEach(async () => {
    server = await createTestServer()
    repo = await createFixtureRepo()
    await repo.commit({ 'a.txt': 'a\n' }, 'init')
    const projectId = (await server.call('POST', routes.projects(), { path: repo.path, defaultBase: 'main' })).body.project.id
    await server.call('GET', routes.project(projectId))
  })
  afterEach(async () => {
    await server.close()
    repo.cleanup()
  })
  const fleetOf = async () => {
    const response = await server.call<{ agents: FleetAgent[] }>('GET', routes.agentFleet())
    expect(response.status).toBe(200)
    return response.body.agents
  }

  it('answers only an authenticated client', async () => {
    expect((await server.app.inject({ method: 'GET', url: routes.agentFleet() })).statusCode).toBe(401)
  })

  it('requires auth', async () => {
    expect((await server.app.inject({ method: 'GET', url: routes.agentFleet() })).statusCode).toBe(401)
  })

  it('shows the ask a running turn is parked on, and drops it once the turn has its answer', async () => {
    let release!: () => void
    server.agent.hold = new Promise<void>((resolve) => (release = resolve))
    server.agent.script = () => [
      { type: 'event', event: fakeEvent(0, { type: 'permission_requested', requestId: 'req-1', callId: 'c1', toolName: 'Bash', input: { command: 'ls' }, reason: null, displayName: null, description: null }) },
      { type: 'event', event: fakeEvent(1, { type: 'permission_decided', requestId: 'req-1', behavior: 'allow' } as unknown as AgentEvent['payload']) },
      { type: 'done', sessionId: 's1' }
    ]
    const turn = server.call('POST', routes.messages('claude', 's1'), { text: 'hi' })

    const [parked] = await vi.waitFor(async () => {
      const agents = await fleetOf()
      expect(agents[0]?.asks).toHaveLength(1)
      return agents
    })
    expect(parked).toMatchObject({ sessionId: 's1', activity: 'approval' })
    expect(parked!.asks.map((ask) => ask.payload)).toEqual([expect.objectContaining({ requestId: 'req-1', toolName: 'Bash' })])

    release()
    await turn
    const [after] = await fleetOf()
    expect(after).toMatchObject({ sessionId: 's1', activity: 'done', asks: [] })
  })
})
