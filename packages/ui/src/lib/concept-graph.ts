import {
  affectedIn,
  conceptsFromAnswer,
  coverageOf,
  diffFingerprint,
  rungsOf,
  walkConcepts,
  type ChangedFile,
  type Concept,
  type ConceptGraph,
  type ConceptMap,
  type HunkIds,
  type HunkRef
} from '@canopy/shared'
import { AgentEventType, isEvent, isMainThread, type AgentEvent } from '@canopy/shared/agent-stream'

/**
 * The Concept Graph pane without React: the map as rungs a reviewer zooms through, the code behind
 * any box, and what makes a tick or a result still valid.
 */

/** One box as the pane draws it, with everything the card needs worked out once. */
export interface ConceptCard {
  concept: Concept
  /** Every hunk under it — its own and its descendants'. Tracing works from any rung. */
  coverage: HunkRef[]
  files: number
  hunks: number
  /** How many rungs of detail sit below it; 0 when it is a leaf. */
  deeper: number
  /** A branch that stopped refining repeats itself on the rungs below this one. */
  repeated: boolean
}

export const cardOf = (concept: Concept, repeated = false): ConceptCard => {
  const coverage = coverageOf(concept)
  return {
    concept,
    coverage,
    files: new Set(coverage.map((ref) => ref.path)).size,
    hunks: coverage.length,
    deeper: Math.max(0, rungsOf(concept).length - 1),
    repeated
  }
}

/** A concept's files in the order they first appear, with the hunks it shows of each; `undefined` is the whole file. */
export function conceptFiles(refs: HunkRef[]): Array<{ path: string; hunks?: number[] }> {
  const files = new Map<string, number[] | undefined>()
  for (const { path, hunk } of refs) {
    const seen = files.has(path) ? files.get(path) : []
    files.set(path, hunk === undefined || seen === undefined ? undefined : [...seen, hunk])
  }
  return [...files].map(([path, hunks]) => (hunks ? { path, hunks } : { path }))
}

/** What a tick is kept under: the hunks it covers, so a remap of the same hunks keeps it. */
export const reviewedKey = (refs: HunkRef[]): string => refs.map(({ path, hunk }) => `${path}#${hunk ?? '*'}`).join('\n')

/** What a map is called in the picker: how it was asked for, or what it was cut from. */
export const mapTitle = (map: Pick<ConceptMap, 'instructions' | 'subject' | 'prNumber'>): string =>
  map.instructions || (map.subject === 'pull-request' && map.prNumber !== null ? `Pull request #${map.prNumber}` : 'This branch')

/**
 * The map a picked id names; otherwise the newest that has an answer, so a brief that never
 * reached its agent does not hide a finished map made just before it; otherwise the newest.
 */
export const pickMap = <T extends Pick<ConceptMap, 'id' | 'result'>>(maps: T[], picked: string | undefined): T | undefined =>
  maps.find((map) => map.id === picked) ?? maps.find((map) => map.result !== undefined) ?? maps[0]

/**
 * A map made from a diff that has since changed shape, or from a PR head that has been pushed past.
 *
 * `files` must be the map's *own* files — the diff between the two trees it was cut from, not the
 * worktree's. Comparing it against the working-tree diff was wrong in both directions: a clean PR
 * branch has no uncommitted change, so the fingerprints never matched and the pane always claimed
 * the PR had moved on, while an unrelated uncommitted edit raised the flag for nothing.
 */
export const isStale = (map: ConceptMap, result: ConceptGraph, files: ChangedFile[], headSha?: string | null): boolean =>
  result.fingerprint !== diffFingerprint(files) || (map.headSha !== null && headSha != null && map.headSha !== headSha)

/** Concepts the change only leans on that depend on something it did change — a prompt, never a proof. */
export const affectedCards = (graph: ConceptGraph): Array<{ concept: Concept; because: Concept[] }> => affectedIn(graph.root, graph.links)

/**
 * A file's stub for the content pane when the map's own diff no longer lists it — the map is older
 * than the trees it was pinned to, or the path is one a context concept names without the change
 * touching it. Shared by the pane and the inspector so they describe such a file the same way.
 */
export const stub = (path: string): ChangedFile =>
  ({
    path,
    status: 'M',
    additions: 0,
    deletions: 0,
    binary: false,
    staged: 'unstaged',
    conflicted: false,
    headSha: null
  }) as ChangedFile

/**
 * The map a session last answered with: the newest main-conversation answer holding a
 * ```concept-graph block, read against the brief that started it. A later "split concept 2" answer
 * replaces an earlier one; a subagent's notes never count.
 */
export function latestConceptGraph(events: readonly AgentEvent[], ids: HunkIds, fingerprint: string, headSha?: string): ConceptGraph | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (!isMainThread(event) || !isEvent(event, AgentEventType.AssistantText)) continue
    const found = conceptsFromAnswer(event.payload.text, ids, fingerprint, headSha)
    if (found) return found
  }
  return undefined
}
