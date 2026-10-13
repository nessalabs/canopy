import { describe, expect, it } from 'vitest'

import type { FleetAgent, Project } from '@canopy/shared'

import { agentHref, filterFleet, fleetCounts, fleetSections } from '../src/lib/agent-fleet'

const agent = (sessionId: string, extra: Partial<FleetAgent> = {}): FleetAgent => ({
  provider: 'claude',
  sessionId,
  title: sessionId,
  kind: 'project',
  projectId: 'p1',
  worktreeId: 'w1',
  activity: 'done',
  updatedAt: 1,
  asks: [],
  ...extra
})
const project = (id: string, name: string) => ({ id, name }) as Project

describe('fleet filters', () => {
  const agents = [agent('a', { activity: 'approval' }), agent('b', { activity: 'running' }), agent('c', { activity: 'running' }), agent('d')]

  it('counts what each filter would show', () => {
    expect(fleetCounts(agents)).toEqual({ all: 4, approval: 1, running: 2, done: 1 })
  })

  it('keeps only the chosen activity, or everything', () => {
    expect(filterFleet(agents, 'running').map((a) => a.sessionId)).toEqual(['b', 'c'])
    expect(filterFleet(agents, 'all')).toHaveLength(4)
  })
})

describe('fleetSections', () => {
  it("puts Canopy's agents first, then each project in order, dropping empty ones", () => {
    const sections = fleetSections([agent('x', { projectId: 'p2' }), agent('g', { kind: 'canopy' })], [project('p1', 'One'), project('p2', 'Two')])
    expect(sections.map((s) => [s.label, s.agents.map((a) => a.sessionId)])).toEqual([
      ['Canopy agents', ['g']],
      ['Two', ['x']]
    ])
  })

  it('leads each section with what waits on someone, then what runs, newest first', () => {
    const [section] = fleetSections(
      [agent('old', { updatedAt: 1 }), agent('new', { updatedAt: 5 }), agent('run', { activity: 'running' }), agent('ask', { activity: 'approval' })],
      [project('p1', 'One')]
    )
    expect(section!.agents.map((a) => a.sessionId)).toEqual(['ask', 'run', 'new', 'old'])
  })
})

describe('agentHref', () => {
  it('opens the Git Agent in the Git tab and any other session in the Agent tab', () => {
    expect(agentHref(agent('g', { kind: 'canopy' }))).toBe('/worktrees/w1?tab=git')
    expect(agentHref(agent('s'))).toBe('/worktrees/w1?tab=agent')
  })
})
