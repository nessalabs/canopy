import { describe, expect, it } from 'vitest'

import type { AgentStreamEvent } from '@canopy/shared'
import type { AgentEvent, AgentEventPayload } from '@canopy/shared/agent-stream'

import { initialTurnState, onEvent, type TurnState } from '../src/lib/use-agent-turn'

let seq = 0
const event = (payload: AgentEventPayload, id = `s:${seq++}`): AgentStreamEvent => ({
  type: 'event',
  event: { id, sessionId: 's', seq, ts: null, agentPath: [], payload, raw: null } as AgentEvent
})
const fold = (state: TurnState, ...events: AgentStreamEvent[]): TurnState => events.reduce(onEvent, state)

describe('turn reducer', () => {
  it('adopts the session id and tracks token progress', () => {
    const state = fold(initialTurnState, { type: 'session', provider: 'claude', sessionId: 's7' }, { type: 'progress', tokens: 128 })
    expect(state.sessionId).toBe('s7')
    expect(state.tokens).toBe(128)
  })

  it('accumulates streamed text, then clears it when the block commits', () => {
    const streamed = fold(
      initialTurnState,
      event({ type: 'delta', delta: 'text', block: { messageId: 'm', index: 0 }, text: 'Hel' }),
      event({ type: 'delta', delta: 'text', block: { messageId: 'm', index: 0 }, text: 'lo' })
    )
    expect(streamed.streamingText).toBe('Hello')
    expect(streamed.activity).toBe('solving')
    const committed = onEvent(streamed, event({ type: 'assistant_text', text: 'Hello', block: { messageId: 'm', index: 0 } }))
    expect(committed.streamingText).toBe('')
    expect(committed.activity).toBe('working')
  })

  it('drives the orb from reasoning and tool calls', () => {
    expect(onEvent(initialTurnState, event({ type: 'reasoning', text: 'think', block: null })).activity).toBe('thinking')
    expect(onEvent(initialTurnState, event({ type: 'tool_call_started', callId: 'c1', name: 'Bash', kind: 'shell', input: {}, title: 'run' })).activity).toBe('working')
  })

  it('merges files frames by call id', () => {
    const state = fold(initialTurnState, { type: 'files', callId: 'c1', files: ['/wt/a.ts'] }, { type: 'files', callId: 'c2', files: ['/wt/b.ts'] })
    expect(state.filesByCall).toEqual({ c1: ['/wt/a.ts'], c2: ['/wt/b.ts'] })
  })

  it('clears the pending prompt when its echo arrives, folding its images onto the event', () => {
    const pending: TurnState = { ...initialTurnState, pending: { text: 'see this', display: 'see this', attachments: [], images: [{ label: 'Image #1', mediaType: 'image/png', data: 'AAA' }] } }
    const echo = event({ type: 'user_message', text: 'see this', synthetic: false }, 's:echo')
    const after = onEvent(pending, echo)
    expect(after.pending).toBeNull()
    expect(after.extras['s:echo']?.images).toHaveLength(1)
  })

  it('keeps the pending prompt for a synthetic (bookkeeping) user event', () => {
    const pending: TurnState = { ...initialTurnState, pending: { text: 'hi', display: 'hi', attachments: [], images: [] } }
    const after = onEvent(pending, event({ type: 'user_message', text: '<system-reminder>x</system-reminder>', synthetic: true }))
    expect(after.pending).toEqual(pending.pending)
  })
})
