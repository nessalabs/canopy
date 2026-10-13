import { describe, expect, it } from 'vitest'

import type { AgentSessionSummary } from '@canopy/shared'

import { activityOf, listFleet, type LiveState } from '../src/agents/fleet'
import type { WorktreeRow } from '../src/worktrees/service'

const session = (sessionId: string, extra: Partial<AgentSessionSummary> = {}): AgentSessionSummary => ({ provider: 'claude', sessionId, title: sessionId, updatedAt: 1, ...extra })
const row = (id: string, project = 'p1'): WorktreeRow => ({ id, project_id: project, name: id, path: `/w/${id}`, branch: null, base_branch: null, is_main: 0, managed: 1, missing: 0, env_state: 'none' })
const idle: LiveState = { running: () => false, awaiting: () => false }

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
    const live: LiveState = { running: (_, sid) => sid === 'r', awaiting: (_, sid) => sid === 'q' }
    const agents = await fleet({ a: [session('r', { updatedAt: 1 }), session('q', { updatedAt: 3 }), session('d', { updatedAt: 2 })] }, live)
    expect(agents.map((agent) => [agent.sessionId, agent.activity])).toEqual([
      ['q', 'approval'],
      ['d', 'done'],
      ['r', 'running']
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
