import { describe, expect, it } from 'vitest'

import { ApiError, diffFingerprint, resolveGraph, type ChangedFile, type GraphReply } from '@canopy/shared'

import type { AgentEvent } from '@canopy/shared/agent-stream'

import { parseGitLink } from '../src/lib/environment-ui'
import { slicePatch } from '../src/lib/patch'
import { cardsOf, graphTitle, isMissingRoute, isStale, latestGraph, leaves, liftEdges, nodeFiles, pickGraph, reviewedKey, tourSteps } from '../src/lib/review-graph'

const ids = { h1: { path: 'db.sql', hunk: 0 }, h2: { path: 'api.ts', hunk: 0 }, h3: { path: 'api.ts', hunk: 1 }, h4: { path: 'ui.tsx', hunk: 0 } }
const reply = (nodes: object[], edges: object[] = []) => ({ nodes, edges }) as unknown as GraphReply
const fill = (r: GraphReply) => ({ nodes: r.nodes.map((n) => ({ summary: '', layers: [], ids: [], commits: [], ...n })), edges: r.edges })

// Schema; Refunds holding API and UI; the UI depends on the schema.
const graph = resolveGraph(
  fill(
    reply(
      [
        { ref: 'schema', kind: 'feature', title: 'Schema', ids: ['h1'] },
        { ref: 'refunds', kind: 'feature', title: 'Refunds' },
        { ref: 'api', title: 'API', ids: ['h2', 'h3'], parent: 'refunds' },
        { ref: 'ui', title: 'UI', ids: ['h4'], parent: 'refunds' }
      ],
      [{ from: 'ui', to: 'schema', kind: 'reads', label: 'refund rows' }]
    )
  ),
  ids
)

describe('tourSteps', () => {
  it('walks top-down, marking stops with no code of their own as intros', () => {
    expect(tourSteps(graph).map((s) => [s.node.title, s.trail.map((t) => t.title), s.children.length, s.reviewable])).toEqual([
      ['Schema', [], 0, true],
      ['Refunds', [], 2, false],
      ['API', ['Refunds'], 0, true],
      ['UI', ['Refunds'], 0, true]
    ])
  })
})

describe('cardsOf', () => {
  it('sums each card over everything inside it, and says where its tour starts', () => {
    const files = [{ path: 'db.sql', status: 'U' }, { path: 'api.ts', status: 'M' }, { path: 'ui.tsx', status: 'A' }] as ChangedFile[]
    const api = graph.nodes.find((n) => n.title === 'API')!
    const top = graph.nodes.filter((n) => n.title === 'Schema' || n.title === 'Refunds')
    expect(cardsOf(graph, top, files, new Set([reviewedKey(api.refs)])).map(({ title, files, hunks, status, steps, reviewed, inside, first }) => ({ title, files, hunks, status, steps, reviewed, inside, first }))).toEqual([
      { title: 'Schema', files: 1, hunks: 1, status: 'added', steps: 1, reviewed: 0, inside: 0, first: 0 },
      { title: 'Refunds', files: 2, hunks: 3, status: 'modified', steps: 2, reviewed: 1, inside: 2, first: 1 }
    ])
  })
})

describe('liftEdges', () => {
  it('moves an edge up to the shown nodes that hold its ends', () => {
    const top = graph.nodes.filter((n) => n.title === 'Schema' || n.title === 'Refunds')
    expect(liftEdges(graph, top)).toEqual([{ from: '2', to: '1', kind: 'reads', label: 'refund rows' }])
    expect(liftEdges(graph, leaves(graph)).map((e) => [e.from, e.to])).toEqual([['2.2', '1']])
  })
})

describe('nodeFiles', () => {
  it('collects hunks per file in first-seen order, and lets a whole-file ref win', () => {
    expect(nodeFiles([{ path: 'b.ts', hunk: 2 }, { path: 'a.ts', hunk: 0 }, { path: 'b.ts', hunk: 0 }, { path: 'logo.png' }, { path: 'a.ts' }])).toEqual([
      { path: 'b.ts', hunks: [2, 0] },
      { path: 'a.ts' },
      { path: 'logo.png' }
    ])
  })
})

describe('slicePatch', () => {
  const patch = ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -1,1 +1,2 @@', ' keep', '+one', '@@ -9,2 +10,1 @@', '-two', '-three', '+four', ''].join('\n')

  it('keeps the header and only the chosen hunks, counting what they change', () => {
    const { patch: sliced, additions, deletions } = slicePatch(patch, [1])
    expect(sliced).toBe('diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -9,2 +10,1 @@\n-two\n-three\n+four\n')
    expect([additions, deletions]).toEqual([1, 2])
  })
})

describe('reviewed and stale', () => {
  it('keys a tick on the hunks it covers', () => {
    expect(reviewedKey([{ path: 'a.ts', hunk: 1 }, { path: 'b.png' }])).toBe('a.ts#1\nb.png#*')
  })

  it('calls an uncommitted graph stale once the diff changes shape, a PR graph once its head moves, and a commit run never', () => {
    const files = [{ path: 'a.ts', additions: 1, deletions: 0 }] as ChangedFile[]
    const result = { fingerprint: diffFingerprint(files) }
    expect(isStale({ scope: { kind: 'uncommitted' } }, result, { files })).toBe(false)
    expect(isStale({ scope: { kind: 'branch' } }, result, { files: [{ ...files[0]!, additions: 2 }] })).toBe(true)
    expect(isStale({ scope: { kind: 'pull-request' }, headSha: 'a' }, result, { prHead: 'b' })).toBe(true)
    expect(isStale({ scope: { kind: 'commits', from: 'a', to: 'b' } }, result, { files: [] })).toBe(false)
  })
})

describe('records', () => {
  it('titles a graph by preset, scope and wording, and picks the newest when nothing is picked', () => {
    expect(graphTitle({ preset: 'data-flow', scope: { kind: 'commits', from: 'abcdef12', to: 'fedcba98' }, instructions: 'by layer' })).toBe('Data flow · Commits abcdef1…fedcba9 · by layer')
    expect(pickGraph([{ id: 'new' }, { id: 'old' }], 'gone')?.id).toBe('new')
  })

  it('sends an old Groups link to the Graph pane', () => {
    expect(parseGitLink('#/worktrees/abc?tab=git&pane=groups').pane).toBe('graph')
  })
})

describe('latestGraph', () => {
  const said = (text: string, agentPath: string[] = []): AgentEvent =>
    ({ id: text, sessionId: 's', seq: 0, ts: null, agentPath, payload: { type: 'assistant_text', text, block: { messageId: 'm', index: 0 } }, raw: null }) as unknown as AgentEvent
  const block = (title: string) => `Here:\n\`\`\`review-graph\n{"nodes":[{"title":"${title}","ids":["h1"]}]}\n\`\`\`\nDone.`

  it('reads the newest main-conversation answer that holds a graph, past later prose and subagent notes', () => {
    const events = [said(block('First')), said(block('Merged')), said('Glad to help.'), said(block('From a subagent'), ['task-1'])]
    expect(latestGraph(events, { h1: ids.h1 }, 'fp')?.nodes.map((n) => n.title)).toEqual(['Merged'])
  })

  it('has nothing before the agent has answered with a graph', () => {
    expect(latestGraph([said('Reading the diff…')], { h1: ids.h1 }, 'fp')).toBeUndefined()
  })
})

describe('isMissingRoute', () => {
  it('tells a daemon with no Graph routes from an ordinary failure', () => {
    expect(isMissingRoute(new ApiError(404, 'http_error', '{"message":"Route POST:/api/v1/worktrees/w/graphs not found"}'))).toBe(true)
    expect(isMissingRoute(new ApiError(404, 'worktree_not_found', 'worktree w not found'))).toBe(false)
    expect(isMissingRoute(new ApiError(400, 'no_pull_request', 'this branch has no pull request'))).toBe(false)
  })
})
