import { CONTAINS, GraphReply, type ReviewEdge, type ReviewNode, type HunkRef, type ReviewGraph } from './schemas/review-graph'

/**
 * Turning an agent's reply into a graph the Graph pane can draw and walk. The agent names hunks
 * by the short ids its brief gave them (`h12`, `f3`) and nodes by slugs of its own; this maps both
 * back and makes the answer whole whatever the agent wrote — every hunk in exactly one node, the
 * nesting a forest, every edge between nodes that exist — so it can run anywhere an answer is read.
 */

/** Hunks by the ids the brief gave them, in the order the diff reads. */
export type HunkIds = Record<string, HunkRef>

/** The node that gathers whatever the agent did not place, so nothing in the change goes unreviewed. */
export const REST_ID = 'rest'
const REST: Omit<ReviewNode, 'refs'> = { id: REST_ID, kind: 'other', title: 'Everything else', summary: 'Changes the graph did not place.', layers: [], commits: [] }

/** An edge with no kind is this one. */
export const DEFAULT_EDGE = 'depends-on'

/**
 * The reply made whole:
 * - hunk ids map back to hunks in diff order; unknown ids are dropped and an id named twice stays
 *   with the first node to name it;
 * - `parent` names a node by its ref; one that names nothing, itself, or closes a loop is dropped,
 *   so nesting is always a forest;
 * - a node with no hunks and nothing left inside it is dropped;
 * - nodes are numbered by their place in the nesting (`1`, `1.2`) and listed parent-first;
 * - unplaced hunks gather in a last node.
 */
export function resolveGraph(reply: GraphReply, ids: HunkIds): Pick<ReviewGraph, 'nodes' | 'edges'> {
  const rank = new Map(Object.keys(ids).map((id, index) => [id, index]))
  const claimed = new Set<string>()
  const claim = (wanted: string[]): HunkRef[] => {
    const mine = [...new Set(wanted.filter((id) => rank.has(id) && !claimed.has(id)))]
    mine.forEach((id) => claimed.add(id))
    return mine.sort((a, b) => rank.get(a)! - rank.get(b)!).map((id) => ids[id]!)
  }
  const refs = reply.nodes.map((node) => claim(node.ids))

  const byRef = new Map<string, number>()
  reply.nodes.forEach((node, i) => {
    if (node.ref && !byRef.has(node.ref)) byRef.set(node.ref, i)
  })
  const parent = reply.nodes.map((node, i) => {
    const at = node.parent === undefined ? undefined : byRef.get(node.parent)
    return at === undefined || at === i ? undefined : at
  })
  // A parent chain that comes back round to where it started is cut where it closes.
  reply.nodes.forEach((_, i) => {
    const seen = new Set([i])
    for (let at = parent[i]; at !== undefined; at = parent[at]) {
      if (seen.has(at)) {
        parent[i] = undefined
        break
      }
      seen.add(at)
    }
  })

  const children = reply.nodes.map(() => [] as number[])
  const roots: number[] = []
  parent.forEach((p, i) => (p === undefined ? roots : children[p]!).push(i))
  const kept = (i: number): boolean => {
    children[i] = children[i]!.filter(kept)
    return refs[i]!.length > 0 || children[i]!.length > 0
  }

  const nodes: ReviewNode[] = []
  const edges: ReviewEdge[] = []
  const idOf = new Map<number, string>()
  const place = (i: number, id: string, parentId?: string): void => {
    const { kind, title, summary, layers, commits } = reply.nodes[i]!
    idOf.set(i, id)
    nodes.push({ id, kind: kind ?? 'node', title, summary, layers, refs: refs[i]!, commits })
    if (parentId) edges.push({ from: parentId, to: id, kind: CONTAINS })
    children[i]!.forEach((child, k) => place(child, `${id}.${k + 1}`, id))
  }
  roots.filter(kept).forEach((i, k) => place(i, `${k + 1}`))

  const rest = Object.keys(ids).filter((id) => !claimed.has(id))
  if (rest.length > 0) nodes.push({ ...REST, refs: rest.map((id) => ids[id]!) })
  return { nodes, edges: [...edges, ...resolveEdges(reply, byRef, idOf)] }
}

/**
 * The reply's edges between nodes that survived, named by ref or by 1-based place in the reply.
 * Nesting is `parent`'s job, so a `contains` edge here is dropped, as are self-edges and repeats.
 */
function resolveEdges(reply: GraphReply, byRef: Map<string, number>, idOf: Map<number, string>): ReviewEdge[] {
  const find = (name: string): string | undefined => {
    const at = byRef.get(name) ?? (/^\d+$/.test(name) ? Number(name) - 1 : undefined)
    return at === undefined ? undefined : idOf.get(at)
  }
  const seen = new Set<string>()
  return reply.edges.flatMap(({ from, to, kind = DEFAULT_EDGE, label }) => {
    const [a, b] = [find(from), find(to)]
    const key = `${a}>${b}:${kind}`
    if (!a || !b || a === b || kind === CONTAINS || seen.has(key)) return []
    seen.add(key)
    return [{ from: a, to: b, kind, ...(label ? { label } : {}) }]
  })
}

/* ------------------------------ walking ------------------------------ */

/** The nodes directly inside `id`, in reading order; the top level when `id` is undefined. */
export function childrenOf(graph: Pick<ReviewGraph, 'nodes' | 'edges'>, id?: string): ReviewNode[] {
  if (id === undefined) return roots(graph)
  const inside = new Set(graph.edges.filter((edge) => edge.kind === CONTAINS && edge.from === id).map((edge) => edge.to))
  return graph.nodes.filter((node) => inside.has(node.id))
}

/** The node `id` sits inside, if any. */
export function parentOf(graph: Pick<ReviewGraph, 'edges'>, id: string): string | undefined {
  return graph.edges.find((edge) => edge.kind === CONTAINS && edge.to === id)?.from
}

/** Nodes inside nothing, in reading order. */
export function roots(graph: Pick<ReviewGraph, 'nodes' | 'edges'>): ReviewNode[] {
  const inner = new Set(graph.edges.filter((edge) => edge.kind === CONTAINS).map((edge) => edge.to))
  return graph.nodes.filter((node) => !inner.has(node.id))
}

/** The ids from the top of the nesting down to `id`, inclusive. */
export function trailTo(graph: Pick<ReviewGraph, 'edges'>, id: string): string[] {
  const trail = [id]
  for (let at = parentOf(graph, id); at !== undefined && !trail.includes(at); at = parentOf(graph, at)) trail.unshift(at)
  return trail
}

/** Every node inside `id`, at any depth, in reading order. */
export function descendants(graph: Pick<ReviewGraph, 'nodes' | 'edges'>, id: string): ReviewNode[] {
  return childrenOf(graph, id).flatMap((child) => [child, ...descendants(graph, child.id)])
}

/** A top-down walk: each top-level node, then everything inside it, depth first. */
export function tourOrder(graph: Pick<ReviewGraph, 'nodes' | 'edges'>): ReviewNode[] {
  return roots(graph).flatMap((node) => [node, ...descendants(graph, node.id)])
}

/** Every hunk a node covers: its own and those of everything inside it. */
export function coverageOf(graph: Pick<ReviewGraph, 'nodes' | 'edges'>, id: string): HunkRef[] {
  const node = graph.nodes.find((candidate) => candidate.id === id)
  return node ? [...node.refs, ...descendants(graph, id).flatMap((inner) => inner.refs)] : []
}

/* ------------------------------ reading ------------------------------ */

/** The fence an agent writes its graph in. */
export const GRAPH_FENCE = 'review-graph'

const BLOCK = new RegExp('```' + GRAPH_FENCE + '[^\\n]*\\n([\\s\\S]*?)\\n```', 'g')

/** A graph block's JSON, as the agent wrote it; undefined while it is still arriving or was not one. */
export function parseGraphJson(source: string): GraphReply | undefined {
  try {
    const reply = GraphReply.safeParse(JSON.parse(source))
    return reply.success ? reply.data : undefined
  } catch {
    return undefined
  }
}

/** The last graph in an answer; undefined when there is none or it does not parse. */
export function parseGraphBlock(text: string): GraphReply | undefined {
  const body = [...text.matchAll(BLOCK)].at(-1)?.[1]
  return body === undefined ? undefined : parseGraphJson(body)
}

/** The graph an answer holds, resolved against the brief's ids; undefined when it holds none. */
export function graphFromAnswer(text: string, ids: HunkIds, fingerprint: string, headSha?: string): ReviewGraph | undefined {
  const reply = parseGraphBlock(text)
  if (!reply) return undefined
  return { ...resolveGraph(reply, ids), fingerprint, ...(headSha ? { headSha } : {}) }
}
