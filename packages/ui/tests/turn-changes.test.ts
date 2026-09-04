import { describe, expect, it } from 'vitest'

import type { AgentEvent, AgentEventPayload } from '@canopy/shared/agent-stream'
import { buildTranscript } from '@canopy/shared/agent-stream'

import { filesByTurn, mergeTurns, relativeTo, resolveTurn, snapshotsByTurn } from '../src/lib/turn-changes'

let seq = 0
const ev = (payload: AgentEventPayload): AgentEvent => {
  const s = seq++
  return { id: `s:${s}`, sessionId: 's', seq: s, ts: null, agentPath: [], payload, raw: null }
}
const prompt = (text: string) => ev({ type: 'user_message', text, synthetic: false })
const toolCall = (callId: string, name: string) => ev({ type: 'tool_call_started', callId, name, kind: name === 'Read' ? 'file_read' : 'file_edit', input: {}, title: name })

describe('turn changes', () => {
  it('relativizes paths inside the worktree only', () => {
    expect(relativeTo('/wt', '/wt/src/a.ts')).toBe('src/a.ts')
    expect(relativeTo('/wt/', '/wt/src/a.ts')).toBe('src/a.ts')
    expect(relativeTo('/wt', '/wt-other/a.ts')).toBeUndefined()
    expect(relativeTo('/wt', '/home/me/.claude/plan.md')).toBeUndefined()
  })

  it('groups written files under the turn that caused them, deduped and sorted', () => {
    seq = 0
    const u1 = prompt('one')
    const c1 = toolCall('c1', 'Edit')
    const c2 = toolCall('c2', 'Edit')
    const u2 = prompt('two')
    const cr = toolCall('cr', 'Read')
    const u3 = prompt('three')
    const c3 = toolCall('c3', 'Edit')
    const transcript = buildTranscript([u1, c1, c2, u2, cr, u3, c3])
    const filesByCall = { c1: ['/wt/b.ts'], c2: ['/wt/a.ts', '/wt/b.ts'], c3: ['/elsewhere/x.ts'] }
    const byTurn = filesByTurn(transcript.turns, filesByCall, '/wt')
    // Only the first turn wrote files inside /wt; its two calls dedupe and sort.
    expect([...byTurn]).toEqual([[`turn:${u1.id}`, ['a.ts', 'b.ts']]])
  })

  it('reads file_edits paths as well as tool write targets', () => {
    seq = 0
    const u1 = prompt('edit via codex')
    const fc = toolCall('fc', 'file change')
    const edits = ev({ type: 'file_edits', callId: 'fc', edits: [{ path: '/wt/x.ts', change: 'update', unifiedDiff: null }] })
    const transcript = buildTranscript([u1, fc, edits])
    expect([...filesByTurn(transcript.turns, {}, '/wt')]).toEqual([[`turn:${u1.id}`, ['x.ts']]])
  })

  it('resolves latest to the newest turn with changes and drops a pinned turn that vanished', () => {
    const byTurn = new Map([['turn:a', ['a']], ['turn:c', ['b']]])
    expect(resolveTurn('latest', byTurn)).toBe('turn:c')
    expect(resolveTurn('turn:a', byTurn)).toBe('turn:a')
    expect(resolveTurn('gone', byTurn)).toBeUndefined()
    expect(resolveTurn(undefined, byTurn)).toBeUndefined()
    expect(resolveTurn('latest', new Map())).toBeUndefined()
  })
})

describe('snapshot turns', () => {
  const snapEdit = (toolUseId: string, path: string, before: string, after: string, attributed = true) => ({ toolUseId, worktreeId: 'w', path, beforeTree: before, afterTree: after, attributed, at: 0 })

  it('folds hook edits into the turn whose tool call made them', () => {
    seq = 0
    const u1 = prompt('one')
    const t1 = toolCall('tu-1', 'Bash')
    const t2 = toolCall('tu-2', 'Edit')
    const u2 = prompt('two')
    const t3 = toolCall('tu-3', 'Bash')
    const transcript = buildTranscript([u1, t1, t2, u2, t3])
    const edits = [snapEdit('tu-1', 'b.ts', 'T0', 'T1'), snapEdit('tu-2', 'a.ts', 'T1', 'T2'), snapEdit('tu-2', 'b.ts', 'T1', 'T2'), snapEdit('tu-3', 'c.ts', 'T2', 'T3', false), snapEdit('tu-x', 'z.ts', 'T3', 'T4')]
    const byTurn = snapshotsByTurn(transcript.turns, edits)
    expect(byTurn.get(`turn:${u1.id}`)).toEqual({ before: 'T0', after: 'T2', files: ['a.ts', 'b.ts'], unattributed: [] })
    expect(byTurn.get(`turn:${u2.id}`)).toEqual({ before: 'T2', after: 'T3', files: ['c.ts'], unattributed: ['c.ts'] })
    expect(byTurn.size).toBe(2)
  })

  it('prefers a snapshot over the transcript-named files for the same turn', () => {
    const snapshot = { before: 'T0', after: 'T1', files: ['a.ts', 'gen.ts'], unattributed: ['gen.ts'] }
    const merged = mergeTurns(new Map([['turn:1', ['a.ts']], ['turn:2', ['b.ts']]]), new Map([['turn:1', snapshot]]))
    expect([...merged]).toEqual([
      ['turn:1', { files: ['a.ts', 'gen.ts'], snapshot }],
      ['turn:2', { files: ['b.ts'] }]
    ])
  })
})
