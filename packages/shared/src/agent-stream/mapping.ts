/** @responsibility The shape every provider's mapping table is written in. */

import type { AgentEventType } from "./events"

/** A frame's kind at the granularity a mapping turns on. */
export type WireKind = string

/**
 * One row of a provider-to-contract table.
 *
 * Every wire has one of these, and they all point at the same
 * [`AgentEventType`] values — which is what makes "swap the transport, keep the
 * components" checkable rather than aspirational. A kind missing from a table
 * is a frame nobody decided about.
 */
export interface MappingEntry {
  /** The normalized events this kind can produce. Empty means it deliberately produces nothing. */
  readonly emits: readonly AgentEventType[]
  /** Why, in one line. For an empty `emits` this is the whole justification. */
  readonly note: string
}
