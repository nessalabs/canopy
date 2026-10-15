import { walkConcepts, type Concept, type ConceptGraph, type ConceptRelation } from '@canopy/shared'

/**
 * The concept map as a network: every concept at every depth, and under the leaves the atoms the
 * change is made of — hunks, commits, files. A hunk two concepts cite, or a commit several arrived
 * in, is one node pulled between them, which is what makes shared ground show up as a hub.
 *
 * Shaped for a force layout. Nothing here is React or d3; it is the graph the network draws.
 */

export type NetNodeKind = 'concept' | 'hunk' | 'commit' | 'path' | 'test'

export interface NetNode {
  id: string
  kind: NetNodeKind
  label: string
  /** The concept's rung, for sizing: 0 is the root. Atoms sit one past the deepest concept. */
  level: number
  concept?: Concept
  /** For a hunk or file: the path, and the hunk's index when it has one. */
  path?: string
  hunk?: number
  /** For a commit. */
  sha?: string
  /** For a concept: whether anything under it looks like a test. The seed of a completeness signal. */
  verified?: boolean
}

export type NetRelation = ConceptRelation | 'refines' | 'owns' | 'cites' | 'concerns' | 'arrived-in' | 'verified-by'

export interface NetEdge {
  id: string
  source: string
  target: string
  relation: NetRelation
  label?: string
}

export interface Network {
  nodes: NetNode[]
  edges: NetEdge[]
  /** How many rungs of concepts there are; atoms hang below the last. */
  depth: number
}

/** A file that reads as a test, by the names people give them. */
export const looksLikeTest = (path: string): boolean => /(^|\/)(tests?|__tests__|spec)\//i.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(path) || /_test\.(py|go|rb|rs)$/i.test(path)

const hunkId = (path: string, hunk: number | undefined): string => `hunk:${path}#${hunk ?? '*'}`
const pathId = (path: string): string => `path:${path}`
const commitId = (sha: string): string => `commit:${sha}`

/** The last part of a path, which is what fits beside a dot. */
const leaf = (path: string): string => path.split('/').pop() ?? path

/**
 * Every concept, with its parent-child spine as `refines` edges, its evidence as atoms hanging off
 * it, and the sideways links the agent drew. Atoms are shared by id, so the same hunk or commit is
 * one node however many concepts point at it.
 */
export function networkOf(graph: ConceptGraph): Network {
  const nodes = new Map<string, NetNode>()
  // By id, not an array: a stored result is schema-valid without having been through the resolver,
  // so it may repeat a hunk or a link, and React Flow needs every edge id to be unique.
  const byEdgeId = new Map<string, NetEdge>()
  const edges = { push: (edge: NetEdge): void => void (byEdgeId.has(edge.id) || byEdgeId.set(edge.id, edge)) }
  const concepts = walkConcepts(graph.root)
  const parents = new Map<string, string>()
  const levels = new Map<string, number>()

  const walk = (concept: Concept, level: number): void => {
    levels.set(concept.id, level)
    for (const child of concept.children) {
      parents.set(child.id, concept.id)
      walk(child, level + 1)
    }
  }
  walk(graph.root, 0)
  const depth = Math.max(0, ...levels.values()) + 1

  const atom = (id: string, make: () => NetNode): NetNode => {
    const found = nodes.get(id)
    if (found) return found
    const made = make()
    nodes.set(id, made)
    return made
  }

  for (const concept of concepts) {
    const level = levels.get(concept.id) ?? 0
    const testy = concept.paths.some(looksLikeTest) || [...concept.owns, ...concept.cites].some((ref) => looksLikeTest(ref.path))
    nodes.set(concept.id, { id: concept.id, kind: 'concept', label: concept.title, level, concept, verified: testy })

    const parent = parents.get(concept.id)
    if (parent) edges.push({ id: `refines:${concept.id}`, source: parent, target: concept.id, relation: 'refines' })

    for (const ref of concept.owns) {
      const id = hunkId(ref.path, ref.hunk)
      const kind = looksLikeTest(ref.path) ? 'test' : 'hunk'
      atom(id, () => ({ id, kind, label: leaf(ref.path), level: depth, path: ref.path, hunk: ref.hunk }))
      edges.push({ id: `owns:${concept.id}>${id}`, source: concept.id, target: id, relation: kind === 'test' ? 'verified-by' : 'owns' })
    }
    for (const ref of concept.cites) {
      const id = hunkId(ref.path, ref.hunk)
      const kind = looksLikeTest(ref.path) ? 'test' : 'hunk'
      atom(id, () => ({ id, kind, label: leaf(ref.path), level: depth, path: ref.path, hunk: ref.hunk }))
      edges.push({ id: `cites:${concept.id}>${id}`, source: concept.id, target: id, relation: 'cites' })
    }
    for (const path of concept.paths) {
      const id = pathId(path)
      const kind = looksLikeTest(path) ? 'test' : 'path'
      atom(id, () => ({ id, kind, label: leaf(path), level: depth, path }))
      edges.push({ id: `concerns:${concept.id}>${id}`, source: concept.id, target: id, relation: kind === 'test' ? 'verified-by' : 'concerns' })
    }
    for (const sha of concept.commits) {
      const id = commitId(sha)
      atom(id, () => ({ id, kind: 'commit', label: sha.slice(0, 7), level: depth, sha }))
      edges.push({ id: `commit:${concept.id}>${id}`, source: concept.id, target: id, relation: 'arrived-in' })
    }
  }

  for (const link of graph.links) {
    if (!nodes.has(link.from) || !nodes.has(link.to)) continue
    edges.push({ id: `${link.kind}:${link.from}>${link.to}`, source: link.from, target: link.to, relation: link.kind, ...(link.label ? { label: link.label } : {}) })
  }

  return { nodes: [...nodes.values()], edges: [...byEdgeId.values()], depth }
}

/** A node's neighbours one step out, and through an atom to whatever else shares it. */
export function neighbourhood(network: Network, id: string): Set<string> {
  const adjacent = new Map<string, string[]>()
  for (const edge of network.edges) {
    adjacent.set(edge.source, [...(adjacent.get(edge.source) ?? []), edge.target])
    adjacent.set(edge.target, [...(adjacent.get(edge.target) ?? []), edge.source])
  }
  const kinds = new Map(network.nodes.map((node) => [node.id, node.kind]))
  const seen = new Set([id])
  for (const next of adjacent.get(id) ?? []) {
    seen.add(next)
    // A shared hunk or commit is a bridge: light up what is on the other side of it too.
    if (kinds.get(next) !== 'concept') for (const beyond of adjacent.get(next) ?? []) seen.add(beyond)
  }
  return seen
}
