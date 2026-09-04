import { describe, expect, it } from 'vitest'

import type { TranscriptItem } from '@canopy/shared'

import { filesByTurn, relativeTo, resolveTurn } from '../src/lib/turn-changes'

const user = (id: string): TranscriptItem => ({ id, role: 'user', text: id })
const edit = (id: string, ...files: string[]): TranscriptItem => ({ id, role: 'tool', tool: 'Edit', text: '', files })

describe('turn changes', () => {
  it('relativizes paths inside the worktree only', () => {
    expect(relativeTo('/wt', '/wt/src/a.ts')).toBe('src/a.ts')
    expect(relativeTo('/wt/', '/wt/src/a.ts')).toBe('src/a.ts')
    expect(relativeTo('/wt', '/wt-other/a.ts')).toBeUndefined()
    expect(relativeTo('/wt', '/home/me/.claude/plan.md')).toBeUndefined()
  })

  it('groups written files under the user turn that caused them, deduped and sorted', () => {
    const items = [
      user('u1'),
      edit('t1', '/wt/b.ts'),
      edit('t2', '/wt/a.ts', '/wt/b.ts'),
      user('u2'),
      { id: 'r', role: 'tool', tool: 'Read', text: '' } as TranscriptItem,
      user('u3'),
      edit('t3', '/elsewhere/x.ts')
    ]
    const byTurn = filesByTurn(items, '/wt')
    expect([...byTurn]).toEqual([['u1', ['a.ts', 'b.ts']]])
  })

  it('resolves latest to the newest turn with changes and drops a pinned turn that vanished', () => {
    const byTurn = new Map([['u1', ['a']], ['u3', ['b']]])
    expect(resolveTurn('latest', byTurn)).toBe('u3')
    expect(resolveTurn('u1', byTurn)).toBe('u1')
    expect(resolveTurn('gone', byTurn)).toBeUndefined()
    expect(resolveTurn(undefined, byTurn)).toBeUndefined()
    expect(resolveTurn('latest', new Map())).toBeUndefined()
  })
})

describe('snapshot turns', () => {
  const edit = (toolUseId: string, path: string, before: string, after: string, attributed = true) => ({ toolUseId, worktreeId: 'w', path, beforeTree: before, afterTree: after, attributed, at: 0 })

  it('folds hook edits into the turn whose tool call made them', async () => {
    const { snapshotsByTurn } = await import('../src/lib/turn-changes')
    const items: TranscriptItem[] = [
      user('u1'),
      { id: 't1', role: 'tool', tool: 'Bash', text: '', toolUseId: 'tu-1' },
      { id: 't2', role: 'tool', tool: 'Edit', text: '', toolUseId: 'tu-2' },
      user('u2'),
      { id: 't3', role: 'tool', tool: 'Bash', text: '', toolUseId: 'tu-3' }
    ]
    const edits = [edit('tu-1', 'b.ts', 'T0', 'T1'), edit('tu-2', 'a.ts', 'T1', 'T2'), edit('tu-2', 'b.ts', 'T1', 'T2'), edit('tu-3', 'c.ts', 'T2', 'T3', false), edit('tu-x', 'z.ts', 'T3', 'T4')]
    const byTurn = snapshotsByTurn(items, edits)
    expect(byTurn.get('u1')).toEqual({ before: 'T0', after: 'T2', files: ['a.ts', 'b.ts'], unattributed: [] })
    expect(byTurn.get('u2')).toEqual({ before: 'T2', after: 'T3', files: ['c.ts'], unattributed: ['c.ts'] })
    expect(byTurn.size).toBe(2)
  })

  it('prefers a snapshot over the transcript-named files for the same turn', async () => {
    const { mergeTurns } = await import('../src/lib/turn-changes')
    const snapshot = { before: 'T0', after: 'T1', files: ['a.ts', 'gen.ts'], unattributed: ['gen.ts'] }
    const merged = mergeTurns(new Map([['u1', ['a.ts']], ['u2', ['b.ts']]]), new Map([['u1', snapshot]]))
    expect([...merged]).toEqual([
      ['u1', { files: ['a.ts', 'gen.ts'], snapshot }],
      ['u2', { files: ['b.ts'] }]
    ])
  })
})
