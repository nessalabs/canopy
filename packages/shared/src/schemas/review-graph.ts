import { z } from 'zod'

import { SessionRef } from './agent'
import { Millis } from './common'
import type { ChangedFile } from './git'

/**
 * A change as a graph a reviewer can walk: typed nodes, each the home of some of the change's
 * hunks, and typed edges between them. Nesting is an edge like any other (`contains`), so one
 * traversal serves the cards, the layered view and the guided tour. Claude writes the graph; the
 * resolver checks it against the diff so every hunk lands in exactly one node.
 */

/** One hunk of one file, by its index in `splitPatch`; without `hunk`, the whole file (binary, rename-only). */
export const HunkRef = z.object({ path: z.string(), hunk: z.number().int().nonnegative().optional() })
export type HunkRef = z.infer<typeof HunkRef>

/**
 * Which change a graph is cut from. `uncommitted` is the checkout against HEAD; `branch` is the
 * checkout against where it left its base; `commits` is a contiguous run, `from` the oldest;
 * `pull-request` is the pair of commits GitHub diffs.
 */
export const GraphScope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('uncommitted') }),
  z.object({ kind: z.literal('branch') }),
  z.object({ kind: z.literal('commits'), from: z.string().regex(/^[0-9a-f]{4,40}$/i), to: z.string().regex(/^[0-9a-f]{4,40}$/i) }),
  z.object({ kind: z.literal('pull-request') })
])
export type GraphScope = z.infer<typeof GraphScope>

/** What the graph is about: the kinds of nodes it is made of and the kinds of edges between them. */
export const GraphPreset = z.enum(['features', 'concepts', 'tasks', 'data-flow', 'data-models', 'classes'])
export type GraphPreset = z.infer<typeof GraphPreset>

/** The edge kind that nests one node inside another. Every other kind comes from the preset. */
export const CONTAINS = 'contains'

export const ReviewNode = z.object({
  /** Its place in the nesting: `1`, `1.2`, `1.2.3`. */
  id: z.string(),
  /** The preset's word for it — feature, concept, task, stage, model, class — or the agent's own. */
  kind: z.string(),
  title: z.string(),
  summary: z.string(),
  /** Where the code sits — frontend, backend, database, tests… — as the model names it. */
  layers: z.array(z.string()),
  /** The hunks this node is the home of. Every hunk has exactly one home across the graph. */
  refs: z.array(HunkRef),
  /** Commits it arrived in, by sha, when the scope has commits. */
  commits: z.array(z.string()).default([])
})
export type ReviewNode = z.infer<typeof ReviewNode>

/** `from` → `to`. For `contains`, `from` is the parent. */
export const ReviewEdge = z.object({ from: z.string(), to: z.string(), kind: z.string(), label: z.string().optional() })
export type ReviewEdge = z.infer<typeof ReviewEdge>

export const ReviewGraph = z.object({
  /** In reading order: a parent before its children, siblings in the order the agent gave them. */
  nodes: z.array(ReviewNode),
  edges: z.array(ReviewEdge),
  /** `diffFingerprint` of the diff it was made from, so a later diff can tell it is old. */
  fingerprint: z.string(),
  /** The PR head at the time, for a pull-request graph, so a push can be noticed. */
  headSha: z.string().optional()
})
export type ReviewGraph = z.infer<typeof ReviewGraph>

export const GraphInput = z.object({
  scope: GraphScope,
  preset: GraphPreset.default('features'),
  /** How the user wants it drawn, in their own words; the preset decides otherwise. */
  instructions: z.string().trim().max(2_000).optional()
})
export type GraphInput = z.input<typeof GraphInput>

/**
 * One graph of one change, kept by the daemon so a worktree can hold several and they outlive a
 * commit. It is pinned to the two trees it was cut from, so its hunks still read once the change
 * is committed, pushed or rebased. `session` is the conversation that answers it; `result` is its
 * newest answer, kept so the graph reads after that transcript is gone.
 */
export const GraphRecord = z.object({
  id: z.string(),
  scope: GraphScope,
  preset: GraphPreset,
  instructions: z.string(),
  before: z.string(),
  after: z.string(),
  /** The short ids the brief named hunks by, which the agent's answers use. */
  ids: z.record(z.string(), HunkRef),
  /**
   * Lines added and removed by each hunk, under `lineKey` (`path#hunk`, `path#*` for a whole file),
   * so a node can say whether it mostly adds or mostly removes. Empty for graphs made before it.
   */
  lines: z.record(z.string(), z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])).default({}),
  fingerprint: z.string(),
  /** The pull request it describes, for a pull-request graph. */
  prNumber: z.number().int().optional(),
  /** The PR head at the time, for a pull-request graph. */
  headSha: z.string().optional(),
  session: SessionRef.optional(),
  result: ReviewGraph.optional(),
  createdAt: Millis
})
export type GraphRecord = z.infer<typeof GraphRecord>

/** A graph just made, and the brief its conversation opens with. */
export const GraphStarted = z.object({ graph: GraphRecord, prompt: z.string() })
export type GraphStarted = z.infer<typeof GraphStarted>

/** What the UI learns about a graph after making it: its conversation, then each newer answer. */
export const GraphPatch = z.object({ session: SessionRef.optional(), result: ReviewGraph.optional() })
export type GraphPatch = z.infer<typeof GraphPatch>

/**
 * What Claude replies with, naming hunks by the short ids the brief gave them (`h12`, `f3`) and
 * nodes by slugs of its own. Lenient wherever a model is loose — missing lists default to empty,
 * extra keys are dropped — because `resolveGraph` is what makes the result whole.
 */
export const GraphReplyNode = z.object({
  /** A slug of the agent's choosing; edges and `parent` name the node by it. */
  ref: z.string().optional(),
  kind: z.string().optional(),
  title: z.string().min(1),
  summary: z.string().default(''),
  layers: z.array(z.string()).default([]),
  ids: z.array(z.string()).default([]),
  commits: z.array(z.string()).default([]),
  /** The ref of the node this one sits inside. */
  parent: z.string().optional()
})
export type GraphReplyNode = z.infer<typeof GraphReplyNode>

export const GraphReply = z.object({
  nodes: z.array(GraphReplyNode),
  edges: z.array(z.object({ from: z.string(), to: z.string(), kind: z.string().optional(), label: z.string().optional() })).default([])
})
export type GraphReply = z.infer<typeof GraphReply>

/** Where a hunk's line counts are kept in `GraphRecord.lines`. */
export const lineKey = ({ path, hunk }: HunkRef): string => `${path}#${hunk ?? '*'}`

/** The diff's shape, worked out the same way on both sides of the wire: which files, how much each changed. */
export const diffFingerprint = (files: Pick<ChangedFile, 'path' | 'additions' | 'deletions'>[]): string =>
  files
    .map((file) => `${file.path}:${file.additions}:${file.deletions}`)
    .sort()
    .join('|')
