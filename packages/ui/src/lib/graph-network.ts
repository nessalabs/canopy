import { CONTAINS, childrenOf, coverageOf, type ReviewGraph, type ReviewNode } from '@canopy/shared'

import { isReviewed, lineTotals } from './review-graph'

/**
 * A review graph as a network: one dot for the whole change at the centre, every node at every
 * depth around it, and under each node the atoms it is made of — its hunks and its commits. A
 * commit several nodes arrived in is one atom pulled between them, so shared ground shows as a hub.
 *
 * Shaped for a force layout or a tree layout. Nothing here is React or d3.
 */

export type NetNodeKind = 'root' | 'node' | 'hunk' | 'test' | 'commit'

/** How far a node got: ticked, still to read, or an intro with no code of its own. */
export type NetState = 'reviewed' | 'unreviewed' | 'intro'

export interface NetNode {
  id: string
  kind: NetNodeKind
  label: string
  /** Rings out from the centre: 0 is the whole change, atoms sit one past the deepest node. */
  level: number
  node?: ReviewNode
  state?: NetState
  /** Lines added and removed across everything the node covers, when the graph kept counts. */
  added?: number
  removed?: number
  path?: string
  hunk?: number
  sha?: string
}

/** `contains` and `owns`/`arrived-in` hold the shape; anything else is a sideways edge the agent drew. */
export interface NetEdge {
  id: string
  source: string
  target: string
  relation: string
  label?: string
}

export interface Network {
  nodes: NetNode[]
  edges: NetEdge[]
  depth: number
}

export const ROOT_ID = 'net:root'
export const SHAPE_RELATIONS: ReadonlySet<string> = new Set([CONTAINS, 'owns', 'tested-by', 'arrived-in'])

/** A file that reads as a test, by the names people give them. */
export const looksLikeTest = (path: string): boolean => /(^|\/)(tests?|__tests__|spec)\//i.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(path) || /_test\.(py|go|rb|rs)$/i.test(path)

const leaf = (path: string): string => path.split('/').pop() ?? path

export function networkOf(graph: Pick<ReviewGraph, 'nodes' | 'edges'>, reviewed: ReadonlySet<string>, opts: { atoms?: boolean; lines?: Readonly<Record<string, [number, number]>> } = {}): Network {
  const atoms = opts.atoms ?? true
  const nodes = new Map<string, NetNode>()
  const edges = new Map<string, NetEdge>()
  const edge = (e: NetEdge): void => void (edges.has(e.id) || edges.set(e.id, e))

  const levels = new Map<string, number>()
  const walk = (node: ReviewNode, level: number): void => {
    levels.set(node.id, level)
    for (const child of childrenOf(graph, node.id)) walk(child, level + 1)
  }
  for (const top of childrenOf(graph)) walk(top, 1)
  const depth = Math.max(1, ...levels.values()) + 1

  nodes.set(ROOT_ID, { id: ROOT_ID, kind: 'root', label: 'Whole change', level: 0 })
  for (const node of graph.nodes) {
    const level = levels.get(node.id) ?? 1
    const state: NetState = node.refs.length === 0 ? 'intro' : isReviewed(reviewed, node) ? 'reviewed' : 'unreviewed'
    const totals = lineTotals(coverageOf(graph, node.id), opts.lines ?? {})
    nodes.set(node.id, { id: node.id, kind: 'node', label: node.title, level, node, state, ...(totals ? { added: totals.added, removed: totals.removed } : {}) })
    if (level === 1) edge({ id: `contains:${ROOT_ID}>${node.id}`, source: ROOT_ID, target: node.id, relation: CONTAINS })
    if (!atoms) continue
    for (const ref of node.refs) {
      const id = `hunk:${ref.path}#${ref.hunk ?? '*'}`
      const test = looksLikeTest(ref.path)
      if (!nodes.has(id)) nodes.set(id, { id, kind: test ? 'test' : 'hunk', label: leaf(ref.path), level: depth, path: ref.path, ...(ref.hunk !== undefined ? { hunk: ref.hunk } : {}) })
      edge({ id: `owns:${node.id}>${id}`, source: node.id, target: id, relation: test ? 'tested-by' : 'owns' })
    }
    for (const sha of node.commits) {
      const id = `commit:${sha}`
      if (!nodes.has(id)) nodes.set(id, { id, kind: 'commit', label: sha.slice(0, 7), level: depth, sha })
      edge({ id: `commit:${node.id}>${id}`, source: node.id, target: id, relation: 'arrived-in' })
    }
  }
  for (const e of graph.edges) {
    if (!nodes.has(e.from) || !nodes.has(e.to)) continue
    edge({ id: `${e.kind}:${e.from}>${e.to}`, source: e.from, target: e.to, relation: e.kind, ...(e.label ? { label: e.label } : {}) })
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], depth }
}

/** A dot's neighbours one step out, and through an atom to whatever else shares it. */
export function neighbourhood(network: Network, id: string): Set<string> {
  const adjacent = new Map<string, string[]>()
  for (const e of network.edges) {
    adjacent.set(e.source, [...(adjacent.get(e.source) ?? []), e.target])
    adjacent.set(e.target, [...(adjacent.get(e.target) ?? []), e.source])
  }
  const kinds = new Map(network.nodes.map((node) => [node.id, node.kind]))
  const seen = new Set([id])
  for (const next of adjacent.get(id) ?? []) {
    seen.add(next)
    const kind = kinds.get(next)
    if (kind === 'hunk' || kind === 'test' || kind === 'commit') for (const beyond of adjacent.get(next) ?? []) seen.add(beyond)
  }
  return seen
}

/** The graph node a dot stands for, or that owns it: where a click on it should open the tour. */
export function ownerOf(network: Network, id: string): string | undefined {
  const dot = network.nodes.find((node) => node.id === id)
  if (!dot || dot.kind === 'root') return undefined
  if (dot.kind === 'node') return dot.id
  return network.edges.find((e) => e.target === id && SHAPE_RELATIONS.has(e.relation))?.source
}
