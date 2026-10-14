import { z } from 'zod'

import { SessionRef } from './agent'
import { HunkRef } from './change-groups'
import { Millis } from './common'

/**
 * A pull request as a hierarchy of concepts — what the change *means*, rung by rung — for
 * reviewing it without reading the diff end to end. Claude writes the hierarchy; the daemon checks
 * it against the diff so nothing goes unreviewed, and the PR-KG pane draws it.
 *
 * The spine is a hierarchy of meaning, not of parts: every rung is a complete account of the whole
 * change, just coarser, so going down adds precision and never new ground. Dependency, replacement
 * and the rest are kept out of the spine as separately named kinds of link, which is what lets the
 * pane deduce from them rather than only draw them.
 */

/** Which change a map is cut from: the pull request GitHub diffs, or the branch against its base. */
export const ConceptSubject = z.enum(['pull-request', 'branch'])
export type ConceptSubject = z.infer<typeof ConceptSubject>

/**
 * What this pull request did to a concept, kept apart from what the concept *is*. `context` is a
 * concept the change only leans on — an existing thing with no edited code of its own.
 */
export const ConceptEffect = z.enum(['added', 'reshaped', 'replaced', 'removed', 'context'])
export type ConceptEffect = z.infer<typeof ConceptEffect>

/**
 * How one concept relates to another, sideways across the spine. Named kinds rather than free text
 * because the pane derives from them: `leans-on` run backwards is what finds the affected set.
 */
export const ConceptRelation = z.enum(['leans-on', 'replaces', 'implements'])
export type ConceptRelation = z.infer<typeof ConceptRelation>

/** `from` leans on / replaces / implements `to`. */
export const ConceptLink = z.object({
  from: z.string(),
  to: z.string(),
  kind: ConceptRelation,
  /** A few words on what passes between them. */
  label: z.string().optional()
})
export type ConceptLink = z.infer<typeof ConceptLink>

/**
 * One box on the map. It carries its own pointers rather than deriving them from its children, so
 * a box high up traces to code exactly as a box at the bottom does.
 */
export interface Concept {
  /** Its place in the spine: `1`, `1.2`, `1.2.3`. Also what links name it by. */
  id: string
  /** The slug the agent gave it, when it gave one; links may name it by this instead. */
  ref?: string
  title: string
  /** What the concept *is*, in the words of the thing being built. */
  summary: string
  /** The agent's own word for what sort of thing it is — capability, policy, data shape. */
  kind?: string
  /** What this change did to it, as opposed to what it is. */
  effect: ConceptEffect
  /** Where the code sits — frontend, backend, database, tests — as the model names it. */
  layers: string[]
  /** The hunks this concept is the home of. Every hunk has exactly one home across the whole map. */
  owns: HunkRef[]
  /** Hunks it points at without owning: the change that proves the point but lives under another roof. */
  cites: HunkRef[]
  /** Commits the concept arrived in, by sha. */
  commits: string[]
  /** Existing files it concerns, including ones this change never touches. */
  paths: string[]
  /** The concepts inside it, each a more precise account of the same ground. */
  children: Concept[]
}

export const Concept: z.ZodType<Concept> = z.lazy(() =>
  z.object({
    id: z.string(),
    ref: z.string().optional(),
    title: z.string(),
    summary: z.string(),
    kind: z.string().optional(),
    effect: ConceptEffect,
    layers: z.array(z.string()),
    owns: z.array(HunkRef),
    cites: z.array(HunkRef),
    commits: z.array(z.string()),
    paths: z.array(z.string()),
    children: z.array(Concept)
  })
)

export const ConceptGraph = z.object({
  /** The single box the review opens on: the whole change said once. */
  root: Concept,
  links: z.array(ConceptLink).default([]),
  /** `diffFingerprint` of the diff it was made from, so a later diff can tell it is old. */
  fingerprint: z.string(),
  /** The PR head the map was made against, when it was cut from a pull request. */
  headSha: z.string().optional()
})
export type ConceptGraph = z.infer<typeof ConceptGraph>

export const ConceptMapInput = z.object({
  /** How the user wants it mapped, in their own words; the stock brief decides otherwise. */
  instructions: z.string().trim().max(2_000).optional(),
  /** Force the branch's change even when the branch has a pull request. */
  subject: ConceptSubject.optional()
})
export type ConceptMapInput = z.infer<typeof ConceptMapInput>

/**
 * One map of one pull request, kept by the daemon so it outlives the conversation that made it and
 * a half-finished review can be come back to. It is pinned to the two commits it was cut from — for
 * a pull request, the pair GitHub itself diffs — so its hunks still read after a commit or a rebase.
 */
export const ConceptMap = z.object({
  id: z.string(),
  subject: ConceptSubject,
  /** The pull request it describes; null when cut from the branch instead. */
  prNumber: z.number().int().nullable(),
  /** The PR head at the time, so a push can be noticed; null for a branch map. */
  headSha: z.string().nullable(),
  instructions: z.string(),
  before: z.string(),
  after: z.string(),
  /** The short ids the brief named hunks by, which the agent's answers use. */
  ids: z.record(z.string(), HunkRef),
  fingerprint: z.string(),
  session: SessionRef.optional(),
  result: ConceptGraph.optional(),
  createdAt: Millis
})
export type ConceptMap = z.infer<typeof ConceptMap>

/** A map just made, and the brief its conversation opens with. */
export const ConceptMapStarted = z.object({ map: ConceptMap, prompt: z.string() })
export type ConceptMapStarted = z.infer<typeof ConceptMapStarted>

/** What the UI learns about a map after making it: its conversation, then each newer answer. */
export const ConceptMapPatch = z.object({ session: SessionRef.optional(), result: ConceptGraph.optional() })
export type ConceptMapPatch = z.infer<typeof ConceptMapPatch>

/**
 * What Claude replies with, naming hunks by the short ids the brief gave them (`h12`, `f3`).
 * Lenient wherever a model is loose — missing lists default to empty, extra keys are dropped —
 * because `resolveConcepts` is what makes the result whole.
 */
export interface ConceptReplyNode {
  title: string
  summary?: string
  kind?: string
  effect?: ConceptEffect
  layers?: string[]
  /** Hunk ids this concept is the home of. */
  ids?: string[]
  /** Hunk ids it points at without owning. */
  cites?: string[]
  commits?: string[]
  paths?: string[]
  /** A slug of the agent's choosing, so links can name it without counting positions. */
  ref?: string
  children?: ConceptReplyNode[]
}

export const ConceptReplyNode: z.ZodType<ConceptReplyNode> = z.lazy(() =>
  z.object({
    title: z.string().min(1),
    summary: z.string().optional(),
    kind: z.string().optional(),
    effect: ConceptEffect.optional(),
    layers: z.array(z.string()).optional(),
    ids: z.array(z.string()).optional(),
    cites: z.array(z.string()).optional(),
    commits: z.array(z.string()).optional(),
    paths: z.array(z.string()).optional(),
    ref: z.string().optional(),
    children: z.array(ConceptReplyNode).optional()
  })
)

export const ConceptReply = z.object({
  root: ConceptReplyNode,
  /** Concepts named by their slug, or by their place in the spine (`1.2`). */
  links: z
    .array(
      z.object({
        from: z.string(),
        to: z.string(),
        kind: ConceptRelation.default('leans-on'),
        label: z.string().optional()
      })
    )
    .default([])
})
export type ConceptReply = z.infer<typeof ConceptReply>
