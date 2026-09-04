/** @responsibility Re-exports the optional layout fold: the turns, tool groups and delegated runs a transcript draws. */

/**
 * Ships behind its own subpath, not the main entry.
 *
 * Grouping events into turns and collapsing a run of same-tool calls behind one
 * row is a layout decision, not a parsing one — a host that draws its own
 * transcript wants the event log and nothing else. Keeping the fold here means
 * the contract entry stops at the agent message, and this module stays
 * available for the hosts that do want the default shape.
 */
export { TranscriptBuilder } from "./builder"
export {
  GROUP_MIN,
  applyDeltas,
  assembleTurn,
  buildTranscript,
  groupTools,
  isCompacting,
  isToolGroup,
  previewOf,
  rendersRow,
  runKey,
  type DelegatedRun,
  type DeltaBuffers,
  type ToolGroup,
  type Transcript,
  type Turn,
  type WorkItem,
} from "./fold"
