import { describe, expect, it } from 'vitest'

import { diffFingerprint, type ChangeGroup, type ChangedFile } from '@canopy/shared'

import type { AgentEvent } from '@canopy/shared/agent-stream'

import { featureCards, isStale, latestGrouping, reviewedKey, reviewSections, sectionFiles } from '../src/lib/change-groups'
import { slicePatch } from '../src/lib/patch'

const group = (id: string, title: string, refs: ChangeGroup['refs'], parts: ChangeGroup['parts'] = []): ChangeGroup => ({ id, title, summary: `${title} summary`, layers: [], refs, parts })

describe('reviewSections', () => {
  it('numbers features, and puts a split feature’s heading over its first part with its own hunks as groundwork', () => {
    const sections = reviewSections([
      group('1', 'Schema', [{ path: 'db.sql', hunk: 0 }]),
      group('2', 'Refunds', [{ path: 'types.ts', hunk: 0 }], [{ id: '2.1', title: 'API', summary: '', layers: ['backend'], refs: [{ path: 'api.ts', hunk: 0 }] }])
    ])
    expect(sections.map((s) => [s.number, s.title, s.heading?.title])).toEqual([
      ['1', 'Schema', undefined],
      ['2.1', 'Groundwork', 'Refunds'],
      ['2.2', 'API', undefined]
    ])
  })
})

describe('sectionFiles', () => {
  it('collects hunks per file in first-seen order, and lets a whole-file ref win', () => {
    expect(
      sectionFiles([
        { path: 'b.ts', hunk: 2 },
        { path: 'a.ts', hunk: 0 },
        { path: 'b.ts', hunk: 0 },
        { path: 'logo.png' },
        { path: 'a.ts' }
      ])
    ).toEqual([{ path: 'b.ts', hunks: [2, 0] }, { path: 'a.ts' }, { path: 'logo.png' }])
  })
})

describe('slicePatch', () => {
  const patch = ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -1,1 +1,2 @@', ' keep', '+one', '@@ -9,2 +10,1 @@', '-two', '-three', '+four', ''].join('\n')

  it('keeps the header and only the chosen hunks, counting what they change', () => {
    const { patch: sliced, additions, deletions } = slicePatch(patch, [1])
    expect(sliced).toBe('diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -9,2 +10,1 @@\n-two\n-three\n+four\n')
    expect([additions, deletions]).toEqual([1, 2])
  })

  it('passes the whole patch through when no hunks are named', () => {
    expect(slicePatch(patch)).toEqual({ patch, additions: 2, deletions: 2 })
  })
})

describe('reviewed and stale', () => {
  it('keys a tick on the hunks it covers', () => {
    expect(reviewedKey([{ path: 'a.ts', hunk: 1 }, { path: 'b.png' }])).toBe('a.ts#1\nb.png#*')
  })

  it('calls groups stale once the diff changes shape', () => {
    const files = [{ path: 'a.ts', additions: 1, deletions: 0 }] as ChangedFile[]
    const result = { groups: [], fingerprint: diffFingerprint(files) }
    expect(isStale(result, files)).toBe(false)
    expect(isStale(result, [{ ...files[0]!, additions: 2 }])).toBe(true)
  })
})

describe('featureCards', () => {
  it('sums each feature over its sections and calls it added only when every file is new', () => {
    const groups = [
      group('1', 'Schema', [{ path: 'db.sql', hunk: 0 }]),
      group('2', 'Refunds', [], [
        { id: '2.1', title: 'API', summary: '', layers: [], refs: [{ path: 'api.ts', hunk: 0 }, { path: 'api.ts', hunk: 1 }] },
        { id: '2.2', title: 'UI', summary: '', layers: [], refs: [{ path: 'ui.tsx', hunk: 0 }] }
      ])
    ]
    const sections = reviewSections(groups)
    const files = [{ path: 'db.sql', status: 'U' }, { path: 'api.ts', status: 'M' }, { path: 'ui.tsx', status: 'A' }] as ChangedFile[]
    const cards = featureCards(groups, sections, files, new Set([reviewedKey(sections[1]!.refs)]))
    expect(cards.map(({ number, files, hunks, status, reviewed, sections, first }) => ({ number, files, hunks, status, reviewed, sections, first }))).toEqual([
      { number: '1', files: 1, hunks: 1, status: 'added', reviewed: 0, sections: 1, first: 0 },
      { number: '2', files: 2, hunks: 3, status: 'modified', reviewed: 1, sections: 2, first: 1 }
    ])
  })
})

describe('latestGrouping', () => {
  const said = (text: string, agentPath: string[] = []): AgentEvent =>
    ({ id: text, sessionId: 's', seq: 0, ts: null, agentPath, payload: { type: 'assistant_text', text, block: { messageId: 'm', index: 0 } }, raw: null }) as unknown as AgentEvent
  const block = (title: string) => `Here:\n\`\`\`change-groups\n{"groups":[{"title":"${title}","ids":["h1"]}]}\n\`\`\`\nDone.`
  const ids = { h1: { path: 'a.ts', hunk: 0 } }

  it('reads the newest main-conversation answer that holds a grouping, past later prose and subagent notes', () => {
    const events = [said(block('First')), said(block('Merged')), said('Glad to help.'), said(block('From a subagent'), ['task-1'])]
    expect(latestGrouping(events, ids, 'fp')?.groups.map((g) => g.title)).toEqual(['Merged'])
  })

  it('has nothing before the agent has answered with a grouping', () => {
    expect(latestGrouping([said('Reading the diff…')], ids, 'fp')).toBeUndefined()
  })
})
