import { describe, expect, it } from 'vitest'

import { AgentStreamEvent, CreateWorktreeInput, DiffSpec, Project, TranscriptResponse } from '../src'

const envelope = {
  id: 's:7', sessionId: 's', seq: 7, ts: null, agentPath: [], raw: null,
  payload: { type: 'assistant_text', text: 'hi', block: null }
}

describe('shared schemas', () => {
  it('round-trips a project', () => {
    const project = {
      id: 'p1', name: 'acme', path: '/tmp/acme', defaultBase: 'main',
      hasCanopyYaml: false, ecosystems: ['node'], createdAt: 1
    }
    expect(Project.parse(project)).toEqual(project)
  })

  it('rejects worktree names git would choke on', () => {
    expect(CreateWorktreeInput.safeParse({ name: 'Feat X', branch: { mode: 'existing', name: 'x' } }).success).toBe(false)
    expect(CreateWorktreeInput.safeParse({ name: 'feat-x', branch: { mode: 'new', name: 'feat/x', base: 'main' } }).success).toBe(true)
  })

  it('discriminates diff specs and stream events', () => {
    expect(DiffSpec.parse({ kind: 'commit', sha: 'abc123' }).kind).toBe('commit')
    expect(AgentStreamEvent.safeParse({ type: 'nope' }).success).toBe(false)
  })

  it('validates only the envelope of an agent-stream event, never its payload kind', () => {
    expect(AgentStreamEvent.parse({ type: 'event', event: envelope })).toEqual({ type: 'event', event: envelope })
    // A newer daemon's payload kind must pass through; the fold decides what to draw.
    const future = { ...envelope, payload: { type: 'from_the_future' } }
    expect(AgentStreamEvent.safeParse({ type: 'event', event: future }).success).toBe(true)
    expect(AgentStreamEvent.safeParse({ type: 'event', event: { ...envelope, seq: '7' } }).success).toBe(false)
    expect(AgentStreamEvent.safeParse({ type: 'event', event: { ...envelope, payload: 'text' } }).success).toBe(false)
    expect(AgentStreamEvent.parse({ type: 'files', callId: 'c1', files: ['/a/b.ts'] }).type).toBe('files')
  })

  it('parses a replayed transcript as an event log with its sidecars', () => {
    const transcript = { events: [envelope], files: { c1: ['/a/b.ts'] }, extras: {}, model: 'claude-opus-5', nextSeq: 8 }
    expect(TranscriptResponse.parse(transcript)).toEqual(transcript)
    expect(TranscriptResponse.safeParse({ ...transcript, nextSeq: -1 }).success).toBe(false)
  })
})
