// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { TranscriptResponse } from '@canopy/shared'
import type { AgentEvent, AgentEventPayload, Transcript } from '@canopy/shared/agent-stream'

import { initialTurnState, type AgentTurn } from '../src/lib/use-agent-turn'
import { useTranscriptModel } from '../src/lib/use-transcript-model'

let seq = 0
const ev = (payload: AgentEventPayload): AgentEvent => {
  const s = seq++
  return { id: `s:${s}`, sessionId: 's', seq: s, ts: null, agentPath: [], payload, raw: null }
}
const prompt = (text: string) => ev({ type: 'user_message', text, synthetic: false })
const said = (text: string) => ev({ type: 'assistant_text', text, block: null })
const read = (callId: string) => ev({ type: 'tool_call_started', callId, name: 'Read', kind: 'file_read', input: {}, title: callId })

const history = (events: AgentEvent[]): TranscriptResponse => ({ events, files: {}, extras: {}, nextSeq: seq })
const turn = (events: AgentEvent[], busy = false): AgentTurn =>
  ({ ...initialTurnState, events, busy, sendMessage: () => Promise.resolve(), sendReview: () => Promise.resolve(), answerPermission: () => Promise.resolve(), stop: () => undefined }) as AgentTurn

describe('useTranscriptModel', () => {
  let host: HTMLDivElement
  let root: Root
  let latest: Transcript | undefined

  function Probe({ replay, live }: { replay: TranscriptResponse | undefined; live: AgentTurn }): null {
    latest = useTranscriptModel(replay, live).transcript
    return null
  }
  const render = (replay: TranscriptResponse | undefined, live: AgentTurn): Transcript => {
    act(() => root.render(<Probe replay={replay} live={live} />))
    return latest as Transcript
  }

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('folds the replay, then extends it with live events instead of refolding', () => {
    const replay = history([prompt('one'), said('first')])
    const first = render(replay, turn([]))
    expect(first.turns).toHaveLength(1)

    const live = [prompt('two'), read('c1')]
    const second = render(replay, turn(live, true))
    expect(second.turns).toHaveLength(2)
    expect(second.abandonedCallIds.has('c1')).toBe(false)
    // Same array identity for what was already there: the replay was not folded twice.
    expect(second.events[0]).toBe(first.events[0])

    const third = render(replay, turn([...live, said('done')], true))
    expect(third.turns[1]?.work.length).toBeGreaterThan(0)
    expect(third.revision).toBeGreaterThan(second.revision)
  })

  it('starts over when the live log is reset or the replay is replaced', () => {
    const replay = history([prompt('one'), said('first')])
    render(replay, turn([prompt('two'), read('c1')], true))
    const reset = render(replay, turn([]))
    expect(reset.turns).toHaveLength(1)

    const refreshed = history([prompt('one'), said('first'), prompt('two'), read('c1'), said('all done')])
    const after = render(refreshed, turn([]))
    expect(after.turns).toHaveLength(2)
    // A finished session's unanswered call is abandoned, not still running.
    expect(after.abandonedCallIds.has('c1')).toBe(true)
  })
})
