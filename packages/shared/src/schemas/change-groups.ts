import { z } from 'zod'

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

/**
 * What a grouping session starts from: the message to send the agent — the stock instructions,
 * the user's wording and every hunk under a short id — and those ids, so its answers can be read
 * back into groups.
 */
export const GroupingBrief = z.object({
  prompt: z.string(),
  ids: z.record(z.string(), HunkRef),
  fingerprint: z.string()
})
export type GroupingBrief = z.infer<typeof GroupingBrief>

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
