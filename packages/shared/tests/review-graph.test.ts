import { describe, expect, it } from 'vitest'

import { GRAPH_PRESETS, graphPrompt } from '../src/graph-presets'
import { childrenOf, coverageOf, graphFromAnswer, parentOf, parseGraphBlock, resolveGraph, tourOrder, trailTo, type HunkIds } from '../src/review-graph'
import { GraphReply, GraphScope } from '../src/schemas/review-graph'

const ids: HunkIds = { h1: { path: 'a.ts', hunk: 0 }, h2: { path: 'a.ts', hunk: 1 }, h3: { path: 'b.ts', hunk: 0 }, f4: { path: 'logo.png' } }
const reply = (nodes: object[], edges: object[] = []) => GraphReply.parse({ nodes, edges })

describe('parseGraphBlock', () => {
  it('reads the last review-graph block and fills what the agent left out', () => {
    const text = '```review-graph\n{"nodes":[{"title":"Old"}]}\n```\nBetter:\n```review-graph\n{"nodes":[{"title":"A","ids":["h1"]}]}\n```'
    expect(parseGraphBlock(text)).toEqual({ nodes: [{ title: 'A', summary: '', layers: [], ids: ['h1'], commits: [] }], edges: [] })
  })

  it('has nothing for prose, a wrong shape or bad JSON', () => {
    expect(parseGraphBlock('no block')).toBeUndefined()
    expect(parseGraphBlock('```review-graph\n{"nope":1}\n```')).toBeUndefined()
    expect(parseGraphBlock('```review-graph\nnot json\n```')).toBeUndefined()
  })
})

describe('resolveGraph', () => {
  it('nests by parent as contains edges, numbers by place, and lists parents first', () => {
    const graph = resolveGraph(
      reply([
        { ref: 'child', title: 'Child', ids: ['h2'], parent: 'top' },
        { ref: 'top', kind: 'feature', title: 'Top', ids: ['h3', 'h1'] },
        { ref: 'other', title: 'Other', ids: ['f4'] }
      ]),
      ids
    )
    expect(graph.nodes.map((n) => [n.id, n.title, n.refs])).toEqual([
      ['1', 'Top', [ids.h1, ids.h3]],
      ['1.1', 'Child', [ids.h2]],
      ['2', 'Other', [ids.f4]]
    ])
    expect(graph.edges).toEqual([{ from: '1', to: '1.1', kind: 'contains' }])
  })

  it('places each hunk once, drops empty leaves, and gathers the unplaced last', () => {
    const graph = resolveGraph(reply([{ title: 'One', ids: ['h1', 'h1', 'h9'] }, { title: 'Two', ids: ['h1'] }]), ids)
    expect(graph.nodes.map((n) => [n.title, n.refs])).toEqual([
      ['One', [ids.h1]],
      ['Everything else', [ids.h2, ids.h3, ids.f4]]
    ])
  })

  it('keeps a hunkless parent that has children, and breaks parent loops', () => {
    const graph = resolveGraph(
      reply([
        { ref: 'a', title: 'A', parent: 'b', ids: ['h1'] },
        { ref: 'b', title: 'B', parent: 'a', ids: ['h2'] },
        { ref: 'group', title: 'Group' },
        { ref: 'leaf', title: 'Leaf', parent: 'group', ids: ['h3', 'f4'] }
      ]),
      ids
    )
    expect(graph.nodes.map((n) => n.title)).toEqual(['A', 'B', 'Group', 'Leaf'])
    expect(graph.edges.filter((e) => e.kind === 'contains')).toHaveLength(2)
  })

  it('keeps sideways edges by ref or place once, defaulting the kind, and drops nesting repeats', () => {
    const graph = resolveGraph(
      reply(
        [
          { ref: 'a', title: 'A', ids: ['h1'] },
          { ref: 'b', title: 'B', ids: ['h2', 'h3', 'f4'] }
        ],
        [{ from: 'b', to: 'a', label: 'types' }, { from: '2', to: '1' }, { from: 'a', to: 'a' }, { from: 'a', to: 'zz' }, { from: 'a', to: 'b', kind: 'contains' }]
      ),
      ids
    )
    expect(graph.edges).toEqual([{ from: '2', to: '1', kind: 'depends-on', label: 'types' }])
  })
})

describe('walking', () => {
  const graph = resolveGraph(
    reply([
      { ref: 'a', title: 'A' },
      { ref: 'a1', title: 'A1', parent: 'a', ids: ['h1'] },
      { ref: 'a2', title: 'A2', parent: 'a', ids: ['h2'] },
      { ref: 'b', title: 'B', ids: ['h3', 'f4'] }
    ]),
    ids
  )

  it('walks top-down, depth first', () => {
    expect(tourOrder(graph).map((n) => n.id)).toEqual(['1', '1.1', '1.2', '2'])
  })

  it('finds children, parents, trails and coverage', () => {
    expect(childrenOf(graph).map((n) => n.id)).toEqual(['1', '2'])
    expect(childrenOf(graph, '1').map((n) => n.id)).toEqual(['1.1', '1.2'])
    expect(parentOf(graph, '1.2')).toBe('1')
    expect(trailTo(graph, '1.2')).toEqual(['1', '1.2'])
    expect(coverageOf(graph, '1')).toEqual([ids.h1, ids.h2])
  })
})

describe('graphFromAnswer', () => {
  it('resolves the answer and carries its fingerprint and head', () => {
    const graph = graphFromAnswer('```review-graph\n{"nodes":[{"title":"A","ids":["h1","h2","h3","f4"]}]}\n```', ids, 'fp', 'abc')
    expect(graph).toMatchObject({ fingerprint: 'fp', headSha: 'abc' })
    expect(graphFromAnswer('nothing', ids, 'fp')).toBeUndefined()
  })
})

describe('graphPrompt', () => {
  it("uses each preset's vocabulary and appends context, wording and the change", () => {
    for (const preset of GRAPH_PRESETS) {
      const prompt = graphPrompt(preset.id, { table: 'h1 @@', context: ['The pull request:\n#1 x'], instructions: 'by layer' })
      expect(prompt).toContain('```review-graph')
      expect(prompt).toContain(preset.edgeKinds[0]!)
      expect(prompt.indexOf('#1 x')).toBeLessThan(prompt.indexOf('by layer'))
      expect(prompt.endsWith('The change:\nh1 @@')).toBe(true)
    }
  })
})

describe('GraphScope', () => {
  it('takes a commit range by sha and refuses anything else', () => {
    expect(GraphScope.parse({ kind: 'commits', from: 'abc1234', to: 'def5678' })).toEqual({ kind: 'commits', from: 'abc1234', to: 'def5678' })
    expect(GraphScope.safeParse({ kind: 'commits', from: 'HEAD~1', to: 'x' }).success).toBe(false)
  })
})

describe('task messages', () => {
  it('round-trips a title and a brief, and leaves typed text alone', async () => {
    const { messageTitle, parseTaskMessage, taskMessage } = await import('../src/task-message')
    const sent = taskMessage('Graph this change: "by layer"', 'Draw the change.\nh1 @@ -1 +1 @@')
    expect(parseTaskMessage(sent)).toEqual({ title: 'Graph this change: ”by layer”', brief: 'Draw the change.\nh1 @@ -1 +1 @@' })
    expect(messageTitle(sent)).toBe('Graph this change: ”by layer”')
    expect(parseTaskMessage('merge 3 and 4')).toBeUndefined()
    expect(messageTitle('merge 3 and 4')).toBe('merge 3 and 4')
  })
})
