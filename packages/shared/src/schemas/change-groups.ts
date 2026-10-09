import { z } from 'zod'

import { SessionRef } from './agent'
import { Millis } from './common'
import { Against, type ChangedFile } from './git'

/**
 * A change split into the features it is made of, for reviewing one feature at a time. Claude
 * writes the grouping; the daemon checks it against the diff so every hunk lands in exactly one
 * group, and the UI draws each group as its story beside its hunks.
 */

export const GroupInput = z.object({
  against: Against,
  /** How the user wants it grouped, in their own words; the stock prompt decides otherwise. */
  instructions: z.string().trim().max(2_000).optional()
})
export type GroupInput = z.infer<typeof GroupInput>

/** One hunk of one file, by its index in `splitPatch`; without `hunk`, the whole file (binary, rename-only). */
export const HunkRef = z.object({ path: z.string(), hunk: z.number().int().nonnegative().optional() })
export type HunkRef = z.infer<typeof HunkRef>

/** A sub-feature: the smallest thing reviewed and ticked off on its own. */
export const ChangeGroupPart = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  /** Where the code sits — frontend, backend, database, tests… — as the model names it. */
  layers: z.array(z.string()),
  refs: z.array(HunkRef)
})
export type ChangeGroupPart = z.infer<typeof ChangeGroupPart>

/** A feature: its own hunks, and, when it is large, the sub-features it splits into. */
export const ChangeGroup = ChangeGroupPart.extend({ parts: z.array(ChangeGroupPart) })
export type ChangeGroup = z.infer<typeof ChangeGroup>

/** One feature building on another: `from` is the one built on, `to` the one building on it. */
export const GroupLink = z.object({ from: z.string(), to: z.string(), label: z.string().optional() })
export type GroupLink = z.infer<typeof GroupLink>

export const ChangeGroups = z.object({
  groups: z.array(ChangeGroup),
  /** How the features lean on each other; absent from groupings made before links existed. */
  links: z.array(GroupLink).default([]),
  /** `diffFingerprint` of the diff the groups were made from, so a later diff can tell they are old. */
  fingerprint: z.string()
})
export type ChangeGroups = z.infer<typeof ChangeGroups>

/**
 * One grouping of a worktree's change, kept by the daemon so a worktree can hold several and they
 * outlive a commit. It is pinned to the two snapshot trees it was made from — the base and the
 * working tree at the time — so its hunks still read once the change is committed and pushed. The
 * conversation that answers it is `session` once it exists; `result` is its newest answer, kept so
 * the groups read even after the session's transcript is gone.
 */
export const ChangeGrouping = z.object({
  id: z.string(),
  against: Against,
  instructions: z.string(),
  before: z.string(),
  after: z.string(),
  /** The short ids the brief named hunks by, which the agent's answers use. */
  ids: z.record(z.string(), HunkRef),
  fingerprint: z.string(),
  session: SessionRef.optional(),
  result: ChangeGroups.optional(),
  createdAt: Millis
})
export type ChangeGrouping = z.infer<typeof ChangeGrouping>

/** A grouping just made, and the brief its conversation opens with: stock instructions, the user's wording and every hunk under its id. */
export const GroupingStarted = z.object({ grouping: ChangeGrouping, prompt: z.string() })
export type GroupingStarted = z.infer<typeof GroupingStarted>

/** What the UI learns about a grouping after making it: its conversation, then each newer answer. */
export const GroupingPatch = z.object({ session: SessionRef.optional(), result: ChangeGroups.optional() })
export type GroupingPatch = z.infer<typeof GroupingPatch>

/**
 * What Claude replies with: groups naming hunks by the short ids the prompt gave them (`h12`,
 * `f3`). Lenient where a model is loose — missing lists default to empty, extra keys are dropped —
 * because `resolveGroups` is what makes the result whole.
 */
const ReplyPart = z.object({
  title: z.string().min(1),
  summary: z.string().default(''),
  layers: z.array(z.string()).default([]),
  ids: z.array(z.string()).default([])
})
export const GroupReply = z.object({
  groups: z.array(ReplyPart.extend({ parts: z.array(ReplyPart).default([]) })),
  /** Features by their 1-based place in `groups`. */
  links: z.array(z.object({ from: z.number().int(), to: z.number().int(), label: z.string().optional() })).default([])
})
export type GroupReply = z.infer<typeof GroupReply>

/** The diff's shape, worked out the same way on both sides of the wire: which files, how much each changed. */
export const diffFingerprint = (files: Pick<ChangedFile, 'path' | 'additions' | 'deletions'>[]): string =>
  files
    .map((file) => `${file.path}:${file.additions}:${file.deletions}`)
    .sort()
    .join('|')
