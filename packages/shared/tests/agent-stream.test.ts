import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  AgentEventType,
  applyDeltas,
  buildTranscript,
  ClaudeStreamMapper,
  isEvent,
  mapClaudeStream,
  previewOf,
  toolKind,
  TranscriptBuilder
} from '../src/agent-stream'

// A real `claude -p --output-format stream-json` capture from nessa_ui's storybook fixtures:
// one turn that runs a single Bash tool. It pins the vendored parser to Canopy's build flags and
// documents the shapes the daemon and UI rely on.
const capture = readFileSync(new URL('./fixtures/agent-stream/tools.jsonl', import.meta.url), 'utf8')

describe('vendored agent-stream', () => {
  const events = mapClaudeStream(capture)

  it('maps a Claude stream-json capture into one session with one tool call', () => {
    const started = events.filter((event) => isEvent(event, AgentEventType.SessionStarted))
    expect(started).toHaveLength(1)
    expect(started[0]?.payload.session.model).toBe('claude-sonnet-5')

    const calls = events.filter((event) => isEvent(event, AgentEventType.ToolCallStarted))
    expect(calls.map((call) => [call.payload.name, call.payload.kind])).toEqual([['Bash', 'shell']])
    expect(toolKind('Edit')).toBe('file_edit')

    const done = events.filter((event) => isEvent(event, AgentEventType.ToolCallCompleted))
    expect(done.map((event) => event.payload.callId)).toEqual(calls.map((call) => call.payload.callId))

    const completed = events.find((event) => isEvent(event, AgentEventType.TurnCompleted))
    expect(completed?.payload.status).toBe('completed')
    expect(completed?.payload.finalText?.startsWith('Done.')).toBe(true)
  })

  it('numbers events monotonically and stamps them with the session id', () => {
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index))
    expect(new Set(events.map((event) => event.sessionId))).toEqual(new Set(['df848375-8b45-45ce-9e8b-7d21757c2deb']))
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length)
  })

  it('folds into one turn whose tool call has a result, identically live and from disk', () => {
    const whole = buildTranscript(events)
    expect(whole.turns).toHaveLength(1)
    expect(whole.turns[0]?.toolCalls).toBe(1)
    expect(whole.turns[0]?.finalText?.startsWith('Done.')).toBe(true)
    const call = events.find((event) => isEvent(event, AgentEventType.ToolCallStarted))
    expect(whole.resultByCallId.get(call?.payload.callId ?? '')?.isError).toBe(false)
    expect(whole.session?.model).toBe('claude-sonnet-5')

    const builder = new TranscriptBuilder()
    for (const event of events) builder.push([event])
    const live = builder.snapshot({ live: false })
    expect(live.turns.map((turn) => [turn.key, turn.toolCalls, turn.finalText])).toEqual(
      whole.turns.map((turn) => [turn.key, turn.toolCalls, turn.finalText])
    )
  })

  it('accumulates streamed text separately from the committed block that supersedes it', () => {
    const buffers = applyDeltas(events)
    const committed = events.filter((event) => isEvent(event, AgentEventType.AssistantText))
    const final = committed.find((event) => event.payload.text.startsWith('Done.'))
    expect(final).toBeDefined()
    // The deltas for that block concatenate to exactly the committed text.
    expect(previewOf(buffers, final?.payload.block ?? null)).toBe(final?.payload.text)
  })

  it('carries a persisted log forward: a mapper resumed at the stored tail mints new ids', () => {
    const resumed = new ClaudeStreamMapper({ startSeq: events.length })
    const line = capture.split('\n').find((row) => row.includes('"type":"assistant"')) ?? ''
    const next = resumed.map(JSON.parse(line))
    expect(next.length).toBeGreaterThan(0)
    expect(next[0]?.seq).toBe(events.length)
    expect(events.some((event) => event.id === next[0]?.id)).toBe(false)
  })
})
