import { describe, expect, it } from 'vitest'

import type { AgentEvent, AgentEventPayload, ToolKind } from '@canopy/shared/agent-stream'
import { buildTranscript } from '@canopy/shared/agent-stream'

import { rowsByTurn } from '../src/lib/turn-rows'
import { beatLabel, beatsOf, describeCounts, type ActivityBeat } from '../src/lib/turn-beats'

let seq = 0
const ev = (payload: AgentEventPayload, agentPath: string[] = []): AgentEvent => {
  const s = seq++
  return { id: `s:${s}`, sessionId: 's', seq: s, ts: null, agentPath, payload, raw: null }
}
const prompt = (text: string) => ev({ type: 'user_message', text, synthetic: false })
const said = (text: string) => ev({ type: 'assistant_text', text, block: null })
const thought = (text: string) => ev({ type: 'reasoning', text, block: null })
const call = (callId: string, name: string, kind: ToolKind, title = callId) => ev({ type: 'tool_call_started', callId, name, kind, input: { title }, title })
const done = (callId: string, isError = false) => ev({ type: 'tool_call_completed', callId, result: { text: isError ? 'boom' : 'ok', isError, structured: null, images: [] } })
const result = (finalText: string | null) =>
  ev({ type: 'turn_completed', status: 'completed', stopReason: null, terminalReason: null, finalText, usage: null, durationMs: null, numTurns: null, permissionDenials: [] })

const beatsFor = (events: AgentEvent[], live = false) => {
  const transcript = buildTranscript(events, { live })
  const rows = rowsByTurn(transcript)
  return transcript.turns.map((turn) => beatsOf(rows.get(turn.key) ?? turn.work, transcript))
}
const activity = (beat: unknown): ActivityBeat => {
  expect((beat as ActivityBeat).kind).toBe('activity')
  return beat as ActivityBeat
}

describe('beatsOf', () => {
  it('collapses everything between two messages into one activity beat', () => {
    const events = [
      prompt('look'),
      said('Let me look.'),
      thought('where is it'),
      call('c1', 'Read', 'file_read', 'a.ts'),
      done('c1'),
      call('c2', 'Grep', 'search', 'foo'),
      done('c2'),
      call('c3', 'Read', 'file_read', 'a.ts'),
      done('c3'),
      call('c4', 'Bash', 'shell', 'ls'),
      done('c4'),
      said('Found it.'),
      result('Found it.')
    ]
    const [turn] = beatsFor(events)
    expect(turn?.map((beat) => beat.kind)).toEqual(['text', 'activity', 'text'])
    const beat = activity(turn?.[1])
    expect(beat.thoughts).toHaveLength(1)
    expect(beat.calls.map((c) => c.callId)).toEqual(['c1', 'c2', 'c3', 'c4'])
    // The same file read twice is one file, not two.
    expect(beat.counts).toEqual({ files: 1, searches: 1, commands: 1, other: 0 })
    expect(beat.status).toBe('complete')
    expect(beatLabel(beat)).toBe('Explored 1 file, 1 search, 1 command')
  })

  it('keeps a live beat running until every call has answered, and words it in the present tense', () => {
    const events = [prompt('go'), call('c1', 'Read', 'file_read', 'a.ts'), done('c1'), call('c2', 'Bash', 'shell', 'npm test')]
    const [turn] = beatsFor(events, true)
    const beat = activity(turn?.[0])
    expect(beat.status).toBe('running')
    expect(beat.calls[1]?.status).toBe('running')
    expect(beatLabel(beat)).toBe('Exploring 1 file, 1 command…')
  })

  it('counts failed calls without turning the whole beat red', () => {
    const events = [prompt('go'), call('c1', 'Edit', 'file_edit', 'a.ts'), done('c1', true), call('c2', 'Edit', 'file_edit', 'a.ts'), done('c2'), result(null)]
    const beat = activity(beatsFor(events)[0]?.[0])
    expect(beat.status).toBe('complete')
    expect(beat.failed).toBe(1)
    expect(beat.calls[0]?.status).toBe('error')
  })

  it('marks a call the turn abandoned as an error in the sheet', () => {
    const events = [prompt('go'), call('c1', 'Bash', 'shell', 'sleep'), result(null)]
    const beat = activity(beatsFor(events)[0]?.[0])
    expect(beat.calls[0]?.abandoned).toBe(true)
    expect(beat.calls[0]?.status).toBe('error')
    expect(beat.status).toBe('complete')
  })

  it('puts a delegated run beside the cue rather than inside the counts', () => {
    const events = [
      prompt('go'),
      call('c1', 'Read', 'file_read', 'a.ts'),
      done('c1'),
      call('t1', 'Task', 'subagent', 'Explore the repo'),
      ev({ type: 'task_started', taskId: 'task-1', callId: 't1', taskKind: 'agent', label: 'Explorer', description: 'Explore the repo', prompt: null, transcriptId: null }),
      ev({ type: 'tool_call_started', callId: 'inner', name: 'Grep', kind: 'search', input: {}, title: 'foo' }, ['t1']),
      ev({ type: 'task_completed', taskId: 'task-1', callId: 't1', status: 'done', summary: 'nothing', usage: null }),
      done('t1'),
      result(null)
    ]
    const [turn] = beatsFor(events)
    expect(turn).toHaveLength(1)
    const beat = activity(turn?.[0])
    expect(beat.calls.map((c) => c.callId)).toEqual(['c1'])
    expect(beat.runs.map((c) => c.callId)).toEqual(['t1'])
    expect(beat.runs[0]?.run?.label).toBe('Explorer')
    expect(beat.counts).toEqual({ files: 1, searches: 0, commands: 0, other: 0 })
  })

  it('collapses a long run of shell commands into one line that says it ran them', () => {
    const titles = ['Look for token usage capture', 'Check pricing data', 'Search server log', 'Inspect pricing data file', 'Count prompt tokens with tiktoken']
    const events = [prompt('total cost?'), ...titles.flatMap((title, i) => [call(`c${i}`, 'Bash', 'shell', title), done(`c${i}`)]), said('Total is $0.42.'), result('Total is $0.42.')]
    const [turn] = beatsFor(events)
    expect(turn?.map((beat) => beat.kind)).toEqual(['activity', 'text'])
    const beat = activity(turn?.[0])
    expect(beatLabel(beat)).toBe('Ran 5 commands')
    expect(beat.calls.map((c) => c.title)).toEqual(titles)
  })

  it('reads a thinking-only beat as a thought', () => {
    const events = [prompt('hi'), thought('hmm'), said('Hello'), result('Hello')]
    const [turn] = beatsFor(events)
    expect(turn?.map((beat) => beat.kind)).toEqual(['activity', 'text'])
    expect(beatLabel(activity(turn?.[0]))).toBe('Thought for a moment')
  })

  it('draws harness machinery as notes and dividers, never as messages', () => {
    const events = [
      prompt('go'),
      call('c1', 'Bash', 'shell', 'rm -rf'),
      ev({ type: 'permission_denied', callId: 'c1', toolName: 'Bash', message: 'declined' }),
      ev({ type: 'user_message', text: '<system-reminder>x</system-reminder>', synthetic: true }),
      ev({ type: 'context_compacted', trigger: 'auto', preTokens: null, postTokens: null, durationMs: null } as AgentEventPayload),
      ev({ type: 'error', message: 'overloaded' }),
      result(null)
    ]
    const [turn] = beatsFor(events)
    expect(turn?.map((beat) => beat.kind)).toEqual(['activity', 'note', 'compacted', 'note'])
    expect(turn?.[1]).toMatchObject({ tone: 'muted', text: 'Bash was not allowed: declined' })
    expect(turn?.[3]).toMatchObject({ tone: 'error', text: 'overloaded' })
  })

  it('renders the closing message the fold lifts out of the turn', () => {
    const events = [prompt('hi'), said('Hi there.'), result('Hi there.')]
    const [turn] = beatsFor(events)
    expect(turn?.map((beat) => beat.kind)).toEqual(['text'])
  })
})

describe('describeCounts', () => {
  it('pluralises each bucket and omits empty ones', () => {
    expect(describeCounts({ files: 1, searches: 2, commands: 0, other: 0 })).toBe('1 file, 2 searches')
    expect(describeCounts({ files: 0, searches: 0, commands: 0, other: 0 })).toBe('')
  })
})
