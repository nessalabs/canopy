import { describe, expect, it } from 'vitest'

import { groupsFromAnswer, parseGroupBlock, resolveGroups, resolveLinks, type HunkIds } from '../src/change-groups'

const refs: HunkIds = { h1: { path: 'a.ts', hunk: 0 }, h2: { path: 'a.ts', hunk: 1 }, h3: { path: 'b.ts', hunk: 0 }, f4: { path: 'logo.png' } }
const part = (title: string, ids: string[]) => ({ title, summary: '', layers: [], ids })

describe('parseGroupBlock', () => {
  it('reads the last change-groups block in an answer and fills what the agent left out', () => {
    const text = 'First try:\n```change-groups\n{"groups":[{"title":"Old","ids":["h1"]}]}\n```\nBetter:\n```change-groups\n{"groups":[{"title":"A","ids":["h1"]}]}\n```\nDone.'
    expect(parseGroupBlock(text)).toEqual({ groups: [{ title: 'A', summary: '', layers: [], ids: ['h1'], parts: [] }], links: [] })
  })

  it('has nothing for prose or a block that is not groups', () => {
    expect(parseGroupBlock('Here are your groups: …')).toBeUndefined()
    expect(parseGroupBlock('```change-groups\n{"nope": 1}\n```')).toBeUndefined()
    expect(parseGroupBlock('```change-groups\nnot json\n```')).toBeUndefined()
  })
})

describe('resolveGroups', () => {
  it('maps ids to hunks in diff order, nesting parts under their feature', () => {
    const groups = resolveGroups({ groups: [{ ...part('Feature', ['h3', 'h1']), parts: [part('Piece', ['h2', 'f4'])] }], links: [] }, refs)
    expect(groups).toEqual([
      { id: '1', title: 'Feature', summary: '', layers: [], refs: [refs.h1, refs.h3], parts: [{ id: '1.1', title: 'Piece', summary: '', layers: [], refs: [refs.h2, refs.f4] }] }
    ])
  })

  it('drops unknown ids and repeats, drops empty groups, and gathers the unplaced into the last group', () => {
    const groups = resolveGroups({ groups: [{ ...part('One', ['h1', 'h1', 'h9']), parts: [] }, { ...part('Two', ['h1']), parts: [part('Empty', [])] }], links: [] }, refs)
    expect(groups.map((g) => [g.title, g.refs])).toEqual([
      ['One', [refs.h1]],
      ['Everything else', [refs.h2, refs.h3, refs.f4]]
    ])
  })
})

describe('resolveLinks', () => {
  it('keeps links between surviving features once, and drops the rest', () => {
    const kept = [{ id: '1' }, { id: '3' }] as Parameters<typeof resolveLinks>[1]
    const links = [{ from: 1, to: 3, label: 'types' }, { from: 1, to: 3 }, { from: 3, to: 3 }, { from: 1, to: 2 }, { from: 9, to: 1 }]
    expect(resolveLinks({ groups: [], links }, kept)).toEqual([{ from: '1', to: '3', label: 'types' }])
  })
})

describe('groupsFromAnswer', () => {
  it('resolves the answer against the brief and carries its fingerprint', () => {
    const text = '```change-groups\n{"groups":[{"title":"A","ids":["h1","h2"]},{"title":"B","ids":["h3"]}],"links":[{"from":1,"to":2}]}\n```'
    const result = groupsFromAnswer(text, refs, 'fp')
    expect(result?.groups.map((g) => g.title)).toEqual(['A', 'B', 'Everything else'])
    expect(result?.links).toEqual([{ from: '1', to: '2' }])
    expect(result?.fingerprint).toBe('fp')
    expect(groupsFromAnswer('no block', refs, 'fp')).toBeUndefined()
  })
})

describe('task messages', () => {
  it('round-trips a title and a brief, and leaves typed text alone', async () => {
    const { messageTitle, parseTaskMessage, taskMessage } = await import('../src/task-message')
    const sent = taskMessage('Group this change: "by layer"', 'Split the change.\nh1 @@ -1 +1 @@')
    expect(parseTaskMessage(sent)).toEqual({ title: 'Group this change: ”by layer”', brief: 'Split the change.\nh1 @@ -1 +1 @@' })
    expect(messageTitle(sent)).toBe('Group this change: ”by layer”')
    expect(parseTaskMessage('merge 3 and 4')).toBeUndefined()
    expect(messageTitle('merge 3 and 4')).toBe('merge 3 and 4')
  })
})
