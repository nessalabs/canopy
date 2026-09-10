import { describe, expect, it } from 'vitest'

import type { AgentEvent, AgentEventPayload, WorkItem } from '@canopy/shared/agent-stream'
import { buildTranscript, isToolGroup } from '@canopy/shared/agent-stream'

import { rowsByTurn } from '../src/lib/turn-rows'

let seq = 0
const ev = (payload: AgentEventPayload): AgentEvent => {
  const s = seq++
  return { id: `s:${s}`, sessionId: 's', seq: s, ts: null, agentPath: [], payload, raw: null }
}
const prompt = (text: string) => ev({ type: 'user_message', text, synthetic: false })
const said = (text: string) => ev({ type: 'assistant_text', text, block: null })
const read = (callId: string) => ev({ type: 'tool_call_started', callId, name: 'Read', kind: 'file_read', input: {}, title: callId })
const result = (finalText: string | null) =>
  ev({ type: 'turn_completed', status: 'completed', stopReason: null, terminalReason: null, finalText, usage: null, durationMs: null, numTurns: null, permissionDenials: [] })
const ids = (rows: readonly WorkItem[] | undefined): string[] => (rows ?? []).map((row) => (isToolGroup(row) ? row.key : row.id))
const rowsOf = (events: AgentEvent[], live = false) => {
  const transcript = buildTranscript(events, { live })
  const rows = rowsByTurn(transcript)
  return transcript.turns.map((turn) => ids(rows.get(turn.key)))
}

describe('rowsByTurn', () => {
  it('draws a one-message reply, which the fold lifts entirely out of the turn', () => {
    const [u, a, r] = [prompt('hi'), said("Hi! I'm ready to help."), result("Hi! I'm ready to help.")]
    const transcript = buildTranscript([u, a, r])
    expect(transcript.turns[0]?.work).toEqual([]) // the fold behaviour this guards against
    expect(ids(rowsByTurn(transcript).get(transcript.turns[0]!.key))).toEqual([a.id])
  })

  it('does the same for a replayed session, whose turns end at the next prompt rather than a result', () => {
    const [u1, a1, u2, a2] = [prompt('one'), said('first'), prompt('two'), said('second')]
    expect(rowsOf([u1, a1, u2, a2])).toEqual([[a1.id], [a2.id]])
  })

  it("keeps a live turn's latest text above the tool calls that followed it", () => {
    const [u, a, c1, c2] = [prompt('look'), said('Let me look.'), read('c1'), read('c2')]
    expect(rowsOf([u, a, c1, c2], true)).toEqual([[a.id, 'group:' + c1.id]])
  })

  it('restores only the message the fold removed when an earlier one says the same thing', () => {
    const [u, a1, c, a2, r] = [prompt('x'), said('Done.'), read('c1'), said('Done.'), result('Done.')]
    expect(rowsOf([u, a1, c, a2, r])).toEqual([[a1.id, c.id, a2.id]])
  })

  it('leaves a turn alone when its final text never was a message', () => {
    const [u, c, r] = [prompt('x'), read('c1'), result('result text with no matching block')]
    expect(rowsOf([u, c, r])).toEqual([[c.id]])
  })

  it('scopes the search to each turn so a repeated answer lands in the right one', () => {
    const [u1, a1, r1, u2, c, a2, r2] = [prompt('a'), said('Same.'), result('Same.'), prompt('b'), read('c1'), said('Same.'), result('Same.')]
    expect(rowsOf([u1, a1, r1, u2, c, a2, r2])).toEqual([[a1.id], [c.id, a2.id]])
  })
})
