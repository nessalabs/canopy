import { describe, expect, it } from 'vitest'

import type { TurnExtras } from '@canopy/shared'
import type { AgentEvent, AgentEventPayload } from '@canopy/shared/agent-stream'
import { buildTranscript } from '@canopy/shared/agent-stream'

import { filePreview, lineCounts, rewindInputFor, rewoundLine } from '../src/lib/rewind'
import type { TurnSnapshot } from '../src/lib/turn-changes'

let seq = 0
const ev = (payload: AgentEventPayload): AgentEvent => {
  const s = seq++
  return { id: `s:${s}`, sessionId: 's', seq: s, ts: null, agentPath: [], payload, raw: null }
}
const prompt = (text: string) => ev({ type: 'user_message', text, synthetic: false })

const snapshot: TurnSnapshot = { before: 'a'.repeat(40), after: 'b'.repeat(40), files: ['a.ts'], unattributed: [] }

/** The single turn of a transcript built from `events`. */
const turnOf = (events: AgentEvent[]) => buildTranscript(events).turns[0]

describe('rewindInputFor', () => {
  it('sends the snapshot tree when hooks recorded one', () => {
    seq = 0
    const user = prompt('one')
    const extras: Record<string, TurnExtras> = { [user.id]: { messageId: 'msg-1' } }
    expect(rewindInputFor(turnOf([user]), extras, snapshot, '/wt')).toEqual({ messageId: 'msg-1', cwd: '/wt', tree: snapshot.before })
  })

  it('falls back to the provider checkpoint when there is no snapshot', () => {
    seq = 0
    const user = prompt('one')
    const extras: Record<string, TurnExtras> = { [user.id]: { messageId: 'msg-1', images: [] } }
    expect(rewindInputFor(turnOf([user]), extras, undefined, '/wt')).toEqual({ messageId: 'msg-1', cwd: '/wt' })
  })

  it('refuses a turn with no provider message id, and one with no prompt at all', () => {
    seq = 0
    const user = prompt('one')
    expect(rewindInputFor(turnOf([user]), {}, snapshot, '/wt')).toBeNull()
    expect(rewindInputFor(turnOf([user]), { [user.id]: { images: [] } }, snapshot, '/wt')).toBeNull()
    expect(rewindInputFor(undefined, { [user.id]: { messageId: 'msg-1' } }, snapshot, '/wt')).toBeNull()
  })

  it('refuses when the checkout it would run in is unknown', () => {
    seq = 0
    const user = prompt('one')
    expect(rewindInputFor(turnOf([user]), { [user.id]: { messageId: 'msg-1' } }, snapshot, '')).toBeNull()
  })
})

describe('dialog copy', () => {
  it('lists at most ten paths and counts the rest', () => {
    const files = Array.from({ length: 13 }, (_, index) => `src/f${index}.ts`)
    expect(filePreview(files)).toEqual({ shown: files.slice(0, 10), more: 3 })
    expect(filePreview(['a.ts'])).toEqual({ shown: ['a.ts'], more: 0 })
  })

  it('shows line counts only when the daemon reported any', () => {
    expect(lineCounts({ insertions: 12, deletions: 3 })).toBe('+12 −3')
    expect(lineCounts({ insertions: 4 })).toBe('+4 −0')
    expect(lineCounts({})).toBeUndefined()
  })

  it('names what a finished rewind did', () => {
    expect(rewoundLine({ filesChanged: ['a.ts', 'b.ts', 'c.ts'] })).toBe('Rewound 3 files')
    expect(rewoundLine({ filesChanged: ['a.ts'] })).toBe('Rewound 1 file')
    expect(rewoundLine({ filesChanged: [] })).toBe('Nothing to rewind — those files already match')
  })
})
