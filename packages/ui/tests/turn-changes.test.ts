import { describe, expect, it } from 'vitest'

import type { AgentEvent, AgentEventPayload } from '@canopy/shared/agent-stream'
import { buildTranscript } from '@canopy/shared/agent-stream'

import { checkoutOf, filesByTurn, mergeTurns, relativeTo, resolveTurn, snapshotsByTurn } from '../src/lib/turn-changes'

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

  it('finds the deepest checkout a path lies in', () => {
    const checkouts = [
      { id: 'main', path: '/repo' },
      { id: 'nested', path: '/repo/.worktrees/x' },
      { id: 'managed', path: '/home/me/.canopy/repo/worktrees/y' }
    ]
    expect(checkoutOf(checkouts, '/repo/src/a.ts')?.id).toBe('main')
    expect(checkoutOf(checkouts, '/repo/.worktrees/x/src/a.ts')?.id).toBe('nested')
    expect(checkoutOf(checkouts, '/home/me/.canopy/repo/worktrees/y/a.ts')?.id).toBe('managed')
    expect(checkoutOf(checkouts, '/home/me/.claude/plan.md')).toBeUndefined()
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
    const byTurn = filesByTurn(transcript.turns, filesByCall, [{ id: 'w', path: '/wt' }])
    // Only the first turn wrote files inside /wt; its two calls dedupe and sort.
    expect([...byTurn].map(([key, files]) => [key, [...files]])).toEqual([[`turn:${u1.id}`, [['w', ['a.ts', 'b.ts']]]]])
  })

  it('attributes a turn that wrote in another checkout to that checkout, keyed by its id', () => {
    seq = 0
    const u1 = prompt('work in the feature worktree')
    const c1 = toolCall('c1', 'Edit')
    const c2 = toolCall('c2', 'Bash')
    const transcript = buildTranscript([u1, c1, c2])
    const checkouts = [
      { id: 'main', path: '/repo' },
      { id: 'feat', path: '/home/me/.canopy/repo/worktrees/feat' }
    ]
    const filesByCall = { c1: ['/home/me/.canopy/repo/worktrees/feat/src/a.ts'], c2: ['/repo/README.md', '/home/me/.canopy/repo/worktrees/feat/src/b.ts'] }
    const byTurn = filesByTurn(transcript.turns, filesByCall, checkouts)
    expect([...(byTurn.get(`turn:${u1.id}`) ?? [])]).toEqual([
      ['feat', ['src/a.ts', 'src/b.ts']],
      ['main', ['README.md']]
    ])
  })

  it('reads file_edits paths as well as tool write targets', () => {
    seq = 0
    const u1 = prompt('edit via codex')
    const fc = toolCall('fc', 'file change')
    const edits = ev({ type: 'file_edits', callId: 'fc', edits: [{ path: '/wt/x.ts', change: 'update', unifiedDiff: null }] })
    const relative = ev({ type: 'file_edits', callId: 'fc', edits: [{ path: 'y.ts', change: 'add', unifiedDiff: null }] })
    const transcript = buildTranscript([u1, fc, edits, relative])
    const byTurn = filesByTurn(transcript.turns, {}, [{ id: 'w', path: '/wt' }, { id: 'other', path: '/elsewhere' }])
    // A relative path is relative to the session's own checkout, the first one given.
    expect([...(byTurn.get(`turn:${u1.id}`) ?? [])]).toEqual([['w', ['x.ts', 'y.ts']]])
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
    expect(byTurn.get(`turn:${u1.id}`)?.get('w')).toEqual({ before: 'T0', after: 'T2', files: ['a.ts', 'b.ts'], unattributed: [] })
    expect(byTurn.get(`turn:${u2.id}`)?.get('w')).toEqual({ before: 'T2', after: 'T3', files: ['c.ts'], unattributed: ['c.ts'] })
    expect(byTurn.size).toBe(2)
  })

  it('keeps a snapshot per checkout, never mixing trees of two worktrees', () => {
    seq = 0
    const u1 = prompt('one')
    const t1 = toolCall('tu-1', 'Edit')
    const t2 = toolCall('tu-2', 'Edit')
    const transcript = buildTranscript([u1, t1, t2])
    const edits = [snapEdit('tu-1', 'a.ts', 'M0', 'M1'), { ...snapEdit('tu-2', 'b.ts', 'F0', 'F1'), worktreeId: 'feat' }]
    const byTurn = snapshotsByTurn(transcript.turns, edits)
    expect([...(byTurn.get(`turn:${u1.id}`) ?? [])]).toEqual([
      ['w', { before: 'M0', after: 'M1', files: ['a.ts'], unattributed: [] }],
      ['feat', { before: 'F0', after: 'F1', files: ['b.ts'], unattributed: [] }]
    ])
  })

  it('prefers a snapshot over the transcript-named files for the same turn', () => {
    const snapshot = { before: 'T0', after: 'T1', files: ['a.ts', 'gen.ts'], unattributed: ['gen.ts'] }
    const named = new Map([
      ['turn:1', new Map([['w', ['a.ts']]])],
      ['turn:2', new Map([['w', ['b.ts']]])]
    ])
    const merged = mergeTurns(named, new Map([['turn:1', new Map([['w', snapshot]])]]), 'w')
    expect([...merged]).toEqual([
      ['turn:1', { worktreeId: 'w', files: ['a.ts', 'gen.ts'], snapshot, elsewhere: 0 }],
      ['turn:2', { worktreeId: 'w', files: ['b.ts'], elsewhere: 0 }]
    ])
  })

  it('reads a turn against the checkout it wrote most in, and counts the rest as elsewhere', () => {
    const named = new Map([
      ['turn:1', new Map([['main', ['README.md']], ['feat', ['src/a.ts', 'src/b.ts']]])],
      ['turn:2', new Map([['main', ['x.ts']], ['feat', ['y.ts']]])]
    ])
    const merged = mergeTurns(named, new Map(), 'main')
    expect(merged.get('turn:1')).toEqual({ worktreeId: 'feat', files: ['src/a.ts', 'src/b.ts'], elsewhere: 1 })
    // A tie goes to the checkout on screen.
    expect(merged.get('turn:2')).toEqual({ worktreeId: 'main', files: ['x.ts'], elsewhere: 1 })
  })

  it('takes a snapshot-only checkout into account when choosing where to read a turn', () => {
    const snapshot = { before: 'F0', after: 'F1', files: ['a.ts', 'b.ts', 'c.ts'], unattributed: ['c.ts'] }
    const merged = mergeTurns(new Map([['turn:1', new Map([['main', ['x.ts']]])]]), new Map([['turn:1', new Map([['feat', snapshot]])]]), 'main')
    expect(merged.get('turn:1')).toEqual({ worktreeId: 'feat', files: ['a.ts', 'b.ts', 'c.ts'], snapshot, elsewhere: 1 })
  })
})
