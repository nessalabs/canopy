import {
  ConceptReply,
  type Concept,
  type ConceptGraph,
  type ConceptLink,
  type ConceptReplyNode
} from './schemas/concept-graph'
import type { HunkIds } from './change-groups'
import type { HunkRef } from './schemas/change-groups'

/**
 * Turning an agent's concept map into one the Concept Graph pane can draw. The agent names hunks by
 * the short ids its brief gave them (`h12`, `f3`); this maps them back and makes the answer whole
 * whatever the agent wrote — so it can run anywhere an answer is read.
 *
 * Two rules survive every kind of looseness. Every hunk gets exactly one home concept, with
 * whatever the agent forgot swept into a last box, so a map can never quietly hide part of a diff.
 * And a concept with no changed code of its own is *kept* — it is the existing thing the change
 * leans on, which is what makes the affected set derivable at all.
 */

const REST_ID = 'rest'

/** The box everything unclaimed is swept into, so nothing in the change goes unreviewed. */
const rest = (refs: HunkRef[]): Concept => ({
  id: REST_ID,
  title: 'Everything else',
  summary: 'Changes the map did not place.',
  effect: 'reshaped',
  layers: [],
  owns: refs,
  cites: [],
  commits: [],
  paths: [],
  children: []
})

/** A concept carrying nothing at all: no code, no citations, no children. Dropped. */
const empty = (concept: Concept): boolean =>
  concept.owns.length === 0 && concept.cites.length === 0 && concept.paths.length === 0 && concept.commits.length === 0 && concept.children.length === 0

/**
 * The hunks a concept kept for itself, given a home of their own once it also has children.
 *
 * Without this, zooming past such a concept loses its groundwork: the rung below shows its children
 * and nothing holds the parent's own code, so the rung stops being a complete account of the change.
 * Moving it into a child instead means only leaves ever own hunks, which is what lets a rung
 * partition the diff exactly once. The Groups pane already shows the same box under the same name.
 */
const groundwork = (concept: Concept, id: string): Concept => ({
  id,
  title: 'Groundwork',
  summary: `The part of "${concept.title}" the rest of it is built on.`,
  effect: concept.effect,
  layers: concept.layers,
  owns: concept.owns,
  cites: [],
  commits: [],
  paths: [],
  children: []
})

/**
 * The reply made whole: ids mapped back to hunks in diff order, unknown ids dropped, a hunk claimed
 * twice kept where it is first claimed, empty concepts dropped, and whatever no concept claimed
 * gathered into a last box under the root.
 *
 * Ids are positional so a link may name a concept without the agent having slugged it: the root is
 * `root`, its children `1`, `2`, …, and theirs `1.1`, `1.2`, … — the same numbering the Groups pane
 * already shows.
 */
export function resolveConcepts(reply: ConceptReply, refs: HunkIds): Concept {
  const rank = new Map(Object.keys(refs).map((id, index) => [id, index]))
  const claimed = new Set<string>()
  const ordered = (ids: string[]): HunkRef[] =>
    [...new Set(ids.filter((id) => rank.has(id)))].sort((a, b) => rank.get(a)! - rank.get(b)!).map((id) => refs[id]!)

  /** Owning a hunk is exclusive: the first concept to claim it in reading order keeps it. */
  const claim = (ids: string[]): HunkRef[] => {
    const mine = ids.filter((id) => rank.has(id) && !claimed.has(id))
    mine.forEach((id) => claimed.add(id))
    return ordered(mine)
  }

  const build = (node: ConceptReplyNode, id: string): Concept => {
    // Depth-first in reading order, and owns before children, so a parent keeps the groundwork it
    // claimed for itself and the first child to name a shared hunk is the one that gets it.
    const mine = (node.ids ?? []).filter((hunk) => rank.has(hunk) && !claimed.has(hunk))
    const ownIds = new Set(mine)
    const owns = claim(mine)
    const kids = (node.children ?? []).map((child, i) => build(child, id === 'root' ? `${i + 1}` : `${id}.${i + 1}`)).filter((child) => !empty(child))
    const concept: Concept = {
      id,
      ...(node.ref ? { ref: node.ref } : {}),
      title: node.title,
      summary: node.summary ?? '',
      ...(node.kind ? { kind: node.kind } : {}),
      effect: node.effect ?? (owns.length > 0 ? 'reshaped' : 'context'),
      layers: node.layers ?? [],
      owns,
      // Citing is not claiming: the same hunk may be cited by any number of concepts. A hunk this
      // concept already owns is not also listed as a citation.
      cites: ordered((node.cites ?? []).filter((hunk) => !ownIds.has(hunk))),
      commits: [...new Set(node.commits ?? [])],
      paths: [...new Set(node.paths ?? [])],
      children: kids
    }
    // Only leaves own hunks, so a rung partitions the diff exactly once however deep it is read.
    return kids.length > 0 && owns.length > 0 ? { ...concept, owns: [], children: [groundwork(concept, id === 'root' ? '0' : `${id}.0`), ...kids] } : concept
  }

  const root = build(reply.root, 'root')
  const left = Object.keys(refs).filter((id) => !claimed.has(id))
  return left.length > 0 ? { ...root, children: [...root.children, rest(ordered(left))] } : root
}

/** Every concept in the map, in reading order, root first. */
export function walkConcepts(root: Concept): Concept[] {
  return [root, ...root.children.flatMap(walkConcepts)]
}

/** Concepts by id and by the slug the agent gave them, for resolving links either way. */
export function conceptIndex(root: Concept): Map<string, Concept> {
  const index = new Map<string, Concept>()
  for (const concept of walkConcepts(root)) {
    index.set(concept.id, concept)
    if (concept.ref && !index.has(concept.ref)) index.set(concept.ref, concept)
  }
  return index
}

/**
 * The reply's sideways links, kept only where both ends survived `resolveConcepts` and rewritten to
 * ids whichever way the agent named them. A link to itself, or the same pair twice, is dropped.
 */
export function resolveConceptLinks(reply: ConceptReply, root: Concept): ConceptLink[] {
  const index = conceptIndex(root)
  const seen = new Set<string>()
  return reply.links.flatMap(({ from, to, kind, label }) => {
    const [a, b] = [index.get(from), index.get(to)]
    if (!a || !b || a.id === b.id) return []
    const key = `${a.id}>${b.id}>${kind}`
    if (seen.has(key)) return []
    seen.add(key)
    return [{ from: a.id, to: b.id, kind, ...(label ? { label } : {}) }]
  })
}

/** Each concept's parent, by id; the root is absent. For walking back up the spine. */
export function parentOf(root: Concept): Map<string, string> {
  const parents = new Map<string, string>()
  const walk = (concept: Concept): void => {
    for (const child of concept.children) {
      parents.set(child.id, concept.id)
      walk(child)
    }
  }
  walk(root)
  return parents
}

/** The path from the root down to `id`, root first and `id` last; empty when it is not in the map. */
export function trailTo(root: Concept, id: string): Concept[] {
  if (root.id === id) return [root]
  for (const child of root.children) {
    const below = trailTo(child, id)
    if (below.length > 0) return [root, ...below]
  }
  return []
}

/** Every hunk under a concept — its own and all its descendants'. Tracing works from any rung. */
export function coverageOf(concept: Concept): HunkRef[] {
  return [...concept.owns, ...concept.children.flatMap(coverageOf)]
}

/** Whether this change edited the concept at all, as opposed to only leaning on it. */
export const isChanged = (concept: Concept): boolean => concept.effect !== 'context'

/**
 * What the change puts at risk without touching: concepts it only leans on, which in turn lean on
 * something it did change. A prompt for the reviewer's attention, never a proof — the map reaches
 * exactly as far as the agent read.
 */
export function affectedIn(root: Concept, links: ConceptLink[]): Array<{ concept: Concept; because: Concept[] }> {
  const index = conceptIndex(root)
  const because = new Map<string, Concept[]>()
  for (const link of links) {
    if (link.kind !== 'leans-on') continue
    const [from, to] = [index.get(link.from), index.get(link.to)]
    if (!from || !to || isChanged(from) || !isChanged(to)) continue
    because.set(from.id, [...(because.get(from.id) ?? []), to])
  }
  return [...because].flatMap(([id, causes]) => {
    const concept = index.get(id)
    return concept ? [{ concept, because: causes }] : []
  })
}

/**
 * The map by rung: rung 0 is the root alone, rung 1 its children, and so on. A branch that stops
 * refining early repeats its deepest concept on every rung below, so each rung stays a complete
 * account of the whole change rather than thinning out as you zoom in.
 */
export function rungsOf(root: Concept): Concept[][] {
  const rungs: Concept[][] = []
  let level = [root]
  while (level.length > 0) {
    rungs.push(level)
    const next = level.flatMap((concept) => (concept.children.length > 0 ? concept.children : []))
    if (next.length === 0) break
    level = level.flatMap((concept) => (concept.children.length > 0 ? concept.children : [concept]))
  }
  return rungs
}

/** How many rungs deep the map goes. */
export const depthOf = (root: Concept): number => rungsOf(root).length

/** The fence an agent writes its concept map in. */
export const CONCEPTS_FENCE = 'concept-graph'

const BLOCK = new RegExp('```' + CONCEPTS_FENCE + '[^\\n]*\\n([\\s\\S]*?)\\n```', 'g')

/** A map block's JSON, as the agent wrote it; undefined while it is still arriving or was not one. */
export function parseConceptJson(source: string): ConceptReply | undefined {
  try {
    const reply = ConceptReply.safeParse(JSON.parse(source))
    return reply.success ? reply.data : undefined
  } catch {
    return undefined
  }
}

/** The last concept map in an answer; undefined when there is none or it does not parse. */
export function parseConceptBlock(text: string): ConceptReply | undefined {
  const body = [...text.matchAll(BLOCK)].at(-1)?.[1]
  return body === undefined ? undefined : parseConceptJson(body)
}

/** The map an answer holds, resolved against the brief's ids; undefined when it holds none. */
export function conceptsFromAnswer(text: string, ids: HunkIds, fingerprint: string, headSha?: string): ConceptGraph | undefined {
  const reply = parseConceptBlock(text)
  if (!reply) return undefined
  const root = resolveConcepts(reply, ids)
  return { root, links: resolveConceptLinks(reply, root), fingerprint, ...(headSha ? { headSha } : {}) }
}
