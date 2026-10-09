import { z } from 'zod'

import { LineSpan, PartStatus } from './change-map'

/**
 * The diagrams an agent draws besides the change map, each in a fenced block of its answer named
 * for it: a call flow, a blast radius, a before/after and a data model. Like the change map they
 * are lenient where an agent might be loose — extra keys dropped, missing lists empty — and every
 * part may name the file and lines that hold it, so clicking it opens that code.
 */

/** Where a part's code is, for the drawing to open. */
const Located = { path: z.string().min(1).optional(), lines: LineSpan.optional() }

const Part = z.object({ id: z.string().min(1), label: z.string().min(1), detail: z.string().optional(), status: PartStatus, ...Located })
const Link = z.object({ from: z.string().min(1), to: z.string().min(1), label: z.string().optional() })
const Framed = { title: z.string().optional(), caption: z.string().optional() }

export const CallFlowSpec = z.object({
  ...Framed,
  participants: z.array(Part).min(1),
  steps: z
    .array(
      z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        label: z.string().min(1),
        detail: z.string().optional(),
        kind: z.enum(['call', 'return', 'async']).optional(),
        status: z.enum(['added', 'modified', 'deleted', 'unchanged']).optional(),
        branch: z.string().optional(),
        ...Located
      })
    )
    .min(1)
})
export type CallFlowSpec = z.infer<typeof CallFlowSpec>

export const BlastRadiusSpec = z.object({
  ...Framed,
  changed: z.array(Part).min(1),
  upstream: z.array(Part).default([]),
  downstream: z.array(Part).default([]),
  tests: z.array(Part.extend({ covers: z.array(z.string()).default([]) })).default([]),
  links: z.array(Link).default([])
})
export type BlastRadiusSpec = z.infer<typeof BlastRadiusSpec>

const Side = z.object({ label: z.string().min(1), detail: z.string().optional(), ...Located })

export const BeforeAfterSpec = z.object({
  ...Framed,
  beforeTitle: z.string().optional(),
  afterTitle: z.string().optional(),
  rows: z
    .array(z.object({ id: z.string().min(1), before: Side.optional(), after: Side.optional(), change: z.enum(['same', 'added', 'removed', 'changed', 'moved']), note: z.string().optional() }))
    .min(1),
  flows: z.array(Link.extend({ side: z.enum(['before', 'after']) })).default([])
})
export type BeforeAfterSpec = z.infer<typeof BeforeAfterSpec>

export const DataModelSpec = z.object({
  ...Framed,
  entities: z
    .array(
      Part.extend({
        fields: z
          .array(
            z.object({
              name: z.string().min(1),
              type: z.string().optional(),
              change: z.enum(['added', 'removed', 'changed']).optional(),
              key: z.enum(['primary', 'foreign']).optional(),
              note: z.string().optional()
            })
          )
          .default([])
      })
    )
    .min(1),
  relations: z.array(Link.extend({ cardinality: z.string().optional() })).default([])
})
export type DataModelSpec = z.infer<typeof DataModelSpec>
