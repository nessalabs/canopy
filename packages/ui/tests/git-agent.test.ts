import { describe, expect, it } from 'vitest'

import { agentStatus, bindSession, closeTab, DIAGRAM_SPECS, diagramPrompt, mostPressing, NO_TABS, openTab, persisted, type AgentTabs } from '../src/lib/git-agent'

const three = (): AgentTabs => ['a', 'b', 'c'].reduce((state, id) => openTab(state, { id, provider: 'claude' }), NO_TABS)

describe('tabs', () => {
  it('opens on the new tab and hands a closed active tab to its neighbour', () => {
    expect(three().active).toBe('c')
    expect(closeTab({ ...three(), active: 'b' }, 'b').active).toBe('c')
    expect(closeTab(three(), 'c').active).toBe('b')
    expect(closeTab({ ...three(), active: 'a' }, 'c').active).toBe('a')
    expect(closeTab({ tabs: [{ id: 'a', provider: 'claude' }], active: 'a' }, 'a')).toEqual({ tabs: [], active: undefined })
  })

  it('keeps only tabs whose conversation exists across a reload', () => {
    const state = bindSession(three(), 'a', { provider: 'claude', sessionId: 's1' })
    expect(state.tabs[0]?.session).toEqual({ provider: 'claude', sessionId: 's1' })
    expect(persisted(state)).toEqual({ tabs: [state.tabs[0]], active: 'a' })
  })
})

describe('agentStatus', () => {
  it('ranks waiting on the user over working, and an unread finish over idle', () => {
    expect(agentStatus({ busy: true, asking: true, error: false, unseen: false })).toBe('input')
    expect(agentStatus({ busy: true, asking: false, error: true, unseen: false })).toBe('running')
    expect(agentStatus({ busy: false, asking: false, error: true, unseen: true })).toBe('error')
    expect(agentStatus({ busy: false, asking: false, error: false, unseen: true })).toBe('done')
    expect(agentStatus({ busy: false, asking: false, error: false, unseen: false })).toBe('idle')
    expect(mostPressing(['done', 'running', 'idle'])).toBe('running')
    expect(mostPressing([])).toBe('idle')
  })
})

describe('diagram suggestions', () => {
  const spec = DIAGRAM_SPECS.find((s) => s.id === 'call-flow')!

  it('gives Codex an outcome-first prompt with every constraint as a bullet', () => {
    const prompt = diagramPrompt(spec, 'codex')
    expect(prompt.split('\n\n').map((part) => part.split(':')[0])).toEqual(['Goal', 'Context', 'Output', 'Constraints', 'Done when'])
    for (const line of spec.constraints) expect(prompt).toContain(`- ${line}`)
  })

  it('gives Claude the same request as one paragraph of prose', () => {
    const prompt = diagramPrompt(spec, 'claude')
    expect(prompt).not.toContain('\n')
    expect(prompt).toContain(spec.goal)
    expect(prompt).toContain('```call-flow block')
    expect(prompt).toContain(spec.done)
  })

  it('names each diagram once', () => {
    expect(new Set(DIAGRAM_SPECS.map((s) => s.id)).size).toBe(DIAGRAM_SPECS.length)
  })
})
