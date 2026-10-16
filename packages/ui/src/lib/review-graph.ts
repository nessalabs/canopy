import {
  ApiError,
  CONTAINS,
  childrenOf,
  coverageOf,
  descendants,
  diffFingerprint,
  graphFromAnswer,
  presetSpec,
  tourOrder,
  trailTo,
  type ChangedFile,
  type GraphRecord,
  type GraphScope,
  type HunkIds,
  lineKey,
  type HunkRef,
  type ReviewEdge,
  type ReviewGraph,
  type ReviewNode
} from '@canopy/shared'
import { AgentEventType, isEvent, isMainThread, type AgentEvent } from '@canopy/shared/agent-stream'

/**
 * The Graph pane without React: the tour a reviewer walks, the cards at each level, the edges
 * lifted to whatever level is on screen, and what keeps a tick or a graph valid.
 */

type Graph = Pick<ReviewGraph, 'nodes' | 'edges'>

/** One stop on the guided tour. */
export interface TourStep {
  node: ReviewNode
  /** Its ancestors, top first, for the trail above it. */
  trail: ReviewNode[]
  /** The nodes directly inside it, which an intro step lists. */
  children: ReviewNode[]
  /** Whether it has code of its own to read and tick; one without is an intro to what is inside it. */
  reviewable: boolean
}

/** A top-down walk: each top-level node, then everything inside it, depth first. */
export function tourSteps(graph: Graph): TourStep[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  return tourOrder(graph).map((node) => ({
    node,
    trail: trailTo(graph, node.id)
      .slice(0, -1)
      .map((id) => byId.get(id)!),
    children: childrenOf(graph, node.id),
    reviewable: node.refs.length > 0
  }))
}

/** What a tick is kept under: the hunks it covers, so redrawing the same hunks keeps it and changing them drops it. */
export const reviewedKey = (refs: HunkRef[]): string => refs.map(lineKey).join('\n')

export const isReviewed = (reviewed: ReadonlySet<string>, node: Pick<ReviewNode, 'refs'>): boolean => node.refs.length > 0 && reviewed.has(reviewedKey(node.refs))

/** A node's files in the order they first appear, with the hunks it shows of each; `undefined` is the whole file. */
export function nodeFiles(refs: HunkRef[]): Array<{ path: string; hunks?: number[] }> {
  const files = new Map<string, number[] | undefined>()
  for (const { path, hunk } of refs) {
    const seen = files.has(path) ? files.get(path) : []
    files.set(path, hunk === undefined || seen === undefined ? undefined : [...seen, hunk])
  }
  return [...files].map(([path, hunks]) => (hunks ? { path, hunks } : { path }))
}

/** One node as a card: what it is, how big, how far reviewed, and where on the tour it starts. */
export interface NodeCard {
  id: string
  title: string
  summary: string
  kind: string
  layers: string[]
  files: number
  hunks: number
  /** Mostly new code, mostly removed code, or both: by line counts when the graph has them, else by file. */
  status: 'added' | 'modified' | 'deleted'
  /** Lines added and removed across everything it covers; absent for a graph made before counts were kept. */
  added?: number
  removed?: number
  /** Reviewable steps at or inside it, and how many of those are ticked. */
  steps: number
  reviewed: number
  /** How many nodes sit directly inside it; a card with some can be opened a level down. */
  inside: number
  /** Its index in `tourSteps`, where opening it on the tour lands. */
  first: number
}

const KIND: Record<ChangedFile['status'], NodeCard['status']> = { A: 'added', U: 'added', D: 'deleted', M: 'modified', T: 'modified' }

/** The given nodes as cards, each counting everything inside it. */
/** Lines added and removed across some hunks, or undefined when the graph kept no counts for them. */
export function lineTotals(refs: HunkRef[], lines: Readonly<Record<string, [number, number]>>): { added: number; removed: number } | undefined {
  let [added, removed, known] = [0, 0, false]
  for (const ref of refs) {
    const counted = lines[lineKey(ref)]
    if (!counted) continue
    known = true
    added += counted[0]
    removed += counted[1]
  }
  return known ? { added, removed } : undefined
}

/** What a node mostly does to the code: a split under 20% either way counts as all one way. */
export function changeShape(totals: { added: number; removed: number }): NodeCard['status'] {
  const all = totals.added + totals.removed
  if (all === 0) return 'modified'
  const share = totals.added / all
  return share >= 0.8 ? 'added' : share <= 0.2 ? 'deleted' : 'modified'
}

export function cardsOf(graph: Graph, nodes: ReviewNode[], files: ChangedFile[], reviewed: ReadonlySet<string>, lines: Readonly<Record<string, [number, number]>> = {}): NodeCard[] {
  const status = new Map(files.map((file) => [file.path, KIND[file.status]]))
  const order = new Map(tourOrder(graph).map((node, index) => [node.id, index]))
  return nodes.map((node) => {
    const refs = coverageOf(graph, node.id)
    const inner = [node, ...descendants(graph, node.id)]
    const steps = inner.filter((step) => step.refs.length > 0)
    const kinds = new Set(refs.map((ref) => status.get(ref.path) ?? 'modified'))
    const totals = lineTotals(refs, lines)
    return {
      id: node.id,
      title: node.title,
      summary: node.summary,
      kind: node.kind,
      layers: node.layers,
      files: new Set(refs.map((ref) => ref.path)).size,
      hunks: refs.length,
      status: totals ? changeShape(totals) : kinds.size === 1 ? [...kinds][0]! : 'modified',
      ...(totals ? { added: totals.added, removed: totals.removed } : {}),
      steps: steps.length,
      reviewed: steps.filter((step) => isReviewed(reviewed, step)).length,
      inside: childrenOf(graph, node.id).length,
      first: order.get(node.id) ?? 0
    }
  })
}

/** Nodes with nothing inside them: the finest level of the graph. */
export const leaves = (graph: Graph): ReviewNode[] => graph.nodes.filter((node) => childrenOf(graph, node.id).length === 0)

/**
 * Every node with something of its own to show: the leaves, and any node that holds hunks itself
 * or has a sideways edge — so a feature's own hunks, and the edges drawn between features with
 * sub-features, are not lost when the layered view shows every detail.
 */
export const details = (graph: Graph): ReviewNode[] => {
  const linked = new Set(graph.edges.filter((edge) => edge.kind !== CONTAINS).flatMap((edge) => [edge.from, edge.to]))
  return graph.nodes.filter((node) => node.refs.length > 0 || linked.has(node.id) || childrenOf(graph, node.id).length === 0)
}

/**
 * The sideways edges as they read among the nodes on screen: each end moved up to the shown node
 * that holds it, so an edge between two sub-features shows between their features. Edges that end
 * up inside one node, or that repeat, are dropped.
 */
export function liftEdges(graph: Graph, shown: ReviewNode[]): ReviewEdge[] {
  const visible = new Set(shown.map((node) => node.id))
  const lift = (id: string): string | undefined => trailTo(graph, id).findLast((at) => visible.has(at))
  const seen = new Set<string>()
  return graph.edges.flatMap((edge) => {
    if (edge.kind === CONTAINS) return []
    const [from, to] = [lift(edge.from), lift(edge.to)]
    const key = `${from}>${to}:${edge.kind}`
    if (!from || !to || from === to || seen.has(key)) return []
    seen.add(key)
    return [{ ...edge, from, to }]
  })
}

/** "depends-on" as "depends on". */
export const edgeWords = (kind: string): string => kind.replace(/-/g, ' ')

/* ------------------------------ records ------------------------------ */

export function scopeLabel(scope: GraphScope): string {
  switch (scope.kind) {
    case 'uncommitted':
      return 'Uncommitted'
    case 'branch':
      return 'Branch'
    case 'commits':
      return scope.from === scope.to ? `Commit ${scope.from.slice(0, 7)}` : `Commits ${scope.from.slice(0, 7)}…${scope.to.slice(0, 7)}`
    case 'pull-request':
      return scope.number !== undefined ? `PR #${scope.number}` : 'Pull request'
  }
}

/** What a graph is called in the picker: what it is about, of which change, and the user's wording. */
export const graphTitle = (record: Pick<GraphRecord, 'preset' | 'scope' | 'instructions'>): string =>
  [presetSpec(record.preset).label, scopeLabel(record.scope), record.instructions].filter(Boolean).join(' · ')

/** The graph a picked id names, or the newest when it names none of them. */
export const pickGraph = <T extends Pick<GraphRecord, 'id'>>(records: T[], picked: string | undefined): T | undefined => records.find((record) => record.id === picked) ?? records[0]

/**
 * Whether the change has moved on since the graph was drawn: the live diff has a different shape,
 * for a graph of the uncommitted change or the branch; the pull request has a new head, for one of
 * the PR. A run of commits never moves.
 */
export function isStale(record: Pick<GraphRecord, 'scope' | 'headSha'>, result: Pick<ReviewGraph, 'fingerprint'>, live: { files?: ChangedFile[]; prHead?: string }): boolean {
  // `prHead` is the head of the PR this graph is of — the branch's own, or the one it numbers.
  switch (record.scope.kind) {
    case 'uncommitted':
    case 'branch':
      return live.files !== undefined && live.files.length > 0 && result.fingerprint !== diffFingerprint(live.files)
    case 'pull-request':
      return live.prHead !== undefined && record.headSha !== undefined && live.prHead !== record.headSha
    case 'commits':
      return false
  }
}

/**
 * The graph a session last answered with: the newest main-conversation answer holding a
 * ```review-graph block, read against the brief that started it. A later "merge 3 and 4" answer
 * replaces an earlier one; a subagent's notes never count.
 */
export function latestGraph(events: readonly AgentEvent[], ids: HunkIds, fingerprint: string, headSha?: string): ReviewGraph | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (!isMainThread(event) || !isEvent(event, AgentEventType.AssistantText)) continue
    const found = graphFromAnswer(event.payload.text, ids, fingerprint, headSha)
    if (found) return found
  }
  return undefined
}

/**
 * The daemon has no Graph routes at all: it was started from a checkout older than this client.
 * Fastify answers an unknown route with its own 404 body, which the client reads as `http_error`.
 */
export const isMissingRoute = (error: unknown): boolean => error instanceof ApiError && error.status === 404 && error.code === 'http_error' && /Route .* not found/.test(error.message)
