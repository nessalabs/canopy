import { z } from 'zod'

/**
 * A change map as an agent writes it, in a ```change-map block of its answer: the parts a change
 * touches and the calls between them. Each part names the file and lines that hold it, so the
 * map can open that code. Lenient where an agent might be loose — extra keys are dropped and a
 * number stands in for a line range — strict where the drawing depends on it.
 */
/** How a part took part in the change; shared by every diagram an agent draws. */
export const PartStatus = z.enum(['added', 'modified', 'deleted', 'affected', 'external'])
export type PartStatus = z.infer<typeof PartStatus>

/** Short text an agent may write as a bare number (`badge: 3`, `cardinality: 1`); read as a string. */
export const ScalarText = z.union([z.string(), z.number()]).transform(String)

/** `84-95` or `84`: where in a file the code sits. An agent may write a bare number. */
export const LineSpan = ScalarText

export const ChangeMapPart = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  /** The file the part lives in, relative to the checkout. */
  path: z.string().min(1).optional(),
  /** `84-95` or `84`: where in `path` the change sits. */
  lines: LineSpan.optional(),
  status: PartStatus,
  /** A short marker in the card's corner — a hunk count, a finding id. */
  badge: ScalarText.optional()
})
export type ChangeMapPart = z.infer<typeof ChangeMapPart>

export const ChangeMapLink = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  label: z.string().optional()
})
export type ChangeMapLink = z.infer<typeof ChangeMapLink>

export const ChangeMapSpec = z.object({
  title: z.string().optional(),
  caption: z.string().optional(),
  nodes: z.array(ChangeMapPart).min(1),
  edges: z.array(ChangeMapLink).default([])
})
export type ChangeMapSpec = z.infer<typeof ChangeMapSpec>
