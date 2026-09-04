/** @responsibility States, as data, which Claude Code line kind becomes which normalized event. */

import { asRecord, asString } from "../../json"
import { AgentEventType, PlanStepStatus, TaskKind } from "../../events"
import {
  ClaudeTaskType,
  ClaudeContentBlockType,
  ClaudeContentDeltaType,
  ClaudeStreamFrameType,
  ClaudeSystemSubtype,
  ClaudeWireType,
} from "./wire"
import type { JsonValue, WireEvent } from "./wire"

/**
 * A line's kind, at the granularity the mapping actually turns on.
 *
 * Not just `type`: a `stream_event` means nothing without its frame, a
 * `content_block_delta` nothing without its delta kind, and an `assistant`
 * line's outcome depends on the block it carries. The key is the smallest
 * thing that determines the answer.
 */
export type ClaudeWireKind = string

/** What one kind of line produces. */
export interface ClaudeMappingEntry {
  /**
   * The normalized events this kind can produce.
   *
   * A set rather than one value because a single line legitimately produces
   * several — a `tool_use` block is a call *and*, when it is a plan tool, a
   * plan update. Empty means the line deliberately produces nothing.
   */
  readonly emits: readonly AgentEventType[]
  /** Why, in one line. For an empty `emits` this is the whole justification. */
  readonly note: string
}

/**
 * The provider-to-contract mapping, as data.
 *
 * Written down rather than left implicit in the mapper's switches so the
 * translation can be *read* — and tested. A second harness fills in a table of
 * the same shape against the same [`AgentEventType`] values, which is what
 * makes "swap the mapper, keep the components" a checkable claim rather than an
 * aspiration.
 *
 * The test suite walks every fixture line, computes its kind, and asserts the
 * mapper emitted exactly what this table promises. A kind missing from here is
 * a line nobody decided about.
 */
export const CLAUDE_EVENT_MAPPING: Readonly<Record<ClaudeWireKind, ClaudeMappingEntry>> = Object.freeze({
  // ---------- session and turn ----------
  [`${ClaudeWireType.System}/${ClaudeSystemSubtype.Init}`]: {
    emits: [AgentEventType.SessionStarted, AgentEventType.ModelChanged],
    note: "one per turn, not per session; a model change is derived from two of them",
  },
  [ClaudeWireType.Result]: {
    emits: [AgentEventType.TurnCompleted],
    note: "the turn terminator, carrying usage, cost and stop reason",
  },

  // ---------- conversation ----------
  [`${ClaudeWireType.Assistant}/${ClaudeContentBlockType.Text}`]: {
    emits: [AgentEventType.AssistantText],
    note: "committed prose; supersedes whatever the deltas previewed",
  },
  [`${ClaudeWireType.Assistant}/${ClaudeContentBlockType.Thinking}`]: {
    emits: [AgentEventType.Reasoning],
    note: "committed reasoning",
  },
  [`${ClaudeWireType.Assistant}/${ClaudeContentBlockType.ToolUse}`]: {
    emits: [AgentEventType.ToolCallStarted, AgentEventType.PlanUpdated],
    note: "a call, plus a plan update when the call is TodoWrite or TaskCreate/TaskUpdate",
  },
  [`${ClaudeWireType.User}/text`]: {
    emits: [AgentEventType.UserMessage, AgentEventType.Error],
    note: "what the user typed, unless it is the CLI's interruption notice",
  },
  [`${ClaudeWireType.User}/${ClaudeContentBlockType.ToolResult}`]: {
    emits: [AgentEventType.ToolCallCompleted, AgentEventType.PlanUpdated],
    note: "a result, plus a plan update when it settles a TaskCreate's id",
  },

  // ---------- streamed preview ----------
  [`${ClaudeWireType.StreamEvent}/${ClaudeStreamFrameType.MessageStart}`]: {
    emits: [],
    note: "records the message id, which is the join key for every block frame after it",
  },
  [`${ClaudeWireType.StreamEvent}/${ClaudeStreamFrameType.ContentBlockStart}`]: {
    emits: [AgentEventType.Delta],
    note: "opens a block and names a tool call before its arguments stream",
  },
  [`${ClaudeWireType.StreamEvent}/${ClaudeStreamFrameType.ContentBlockDelta}/${ClaudeContentDeltaType.Text}`]: {
    emits: [AgentEventType.Delta],
    note: "prose fragment",
  },
  [`${ClaudeWireType.StreamEvent}/${ClaudeStreamFrameType.ContentBlockDelta}/${ClaudeContentDeltaType.Thinking}`]: {
    emits: [AgentEventType.Delta],
    note: "reasoning fragment; the block's start already said which kind it is",
  },
  [`${ClaudeWireType.StreamEvent}/${ClaudeStreamFrameType.ContentBlockDelta}/${ClaudeContentDeltaType.InputJson}`]: {
    emits: [AgentEventType.Delta],
    note: "tool-argument fragment, parseable only once every fragment is concatenated",
  },
  [`${ClaudeWireType.StreamEvent}/${ClaudeStreamFrameType.ContentBlockDelta}/${ClaudeContentDeltaType.Signature}`]: {
    emits: [],
    note: "signs a thinking block; not display content",
  },
  [`${ClaudeWireType.StreamEvent}/${ClaudeStreamFrameType.ContentBlockStop}`]: {
    emits: [AgentEventType.Delta],
    note: "closes a block",
  },
  [`${ClaudeWireType.StreamEvent}/${ClaudeStreamFrameType.MessageDelta}`]: {
    emits: [],
    note: "terminal metadata the result line already carries",
  },
  [`${ClaudeWireType.StreamEvent}/${ClaudeStreamFrameType.MessageStop}`]: {
    emits: [],
    note: "terminal metadata the result line already carries",
  },

  // ---------- delegated work ----------
  [`${ClaudeWireType.System}/${ClaudeSystemSubtype.TaskStarted}`]: {
    emits: [AgentEventType.TaskStarted],
    note: "a subagent, a workflow or a backgrounded shell begins",
  },
  [`${ClaudeWireType.System}/${ClaudeSystemSubtype.TaskProgress}`]: {
    emits: [AgentEventType.TaskProgress, AgentEventType.WorkflowProgress],
    note: "a live status line, plus a workflow's phase-and-agent board when it carries one",
  },
  [`${ClaudeWireType.System}/${ClaudeSystemSubtype.TaskUpdated}`]: {
    emits: [AgentEventType.TaskCompleted],
    note: "a status patch; the only completion signal a task that never notifies sends",
  },
  [`${ClaudeWireType.System}/${ClaudeSystemSubtype.TaskNotification}`]: {
    emits: [AgentEventType.TaskCompleted],
    note: "the run's outcome and where its output was written",
  },
  [`${ClaudeWireType.System}/${ClaudeSystemSubtype.TaskSummary}`]: {
    emits: [AgentEventType.Activity],
    note: "a one-line gloss; nothing to show when it carries no detail",
  },
  [`${ClaudeWireType.System}/${ClaudeSystemSubtype.BackgroundTasksChanged}`]: {
    emits: [AgentEventType.BackgroundTasksChanged],
    note: "the whole outstanding set, republished; half of whether a session is idle",
  },

  // ---------- session-level reports ----------
  [`${ClaudeWireType.System}/${ClaudeSystemSubtype.Status}`]: {
    emits: [AgentEventType.StatusChanged],
    note: "requesting, compacting, and the permission mode",
  },
  [`${ClaudeWireType.System}/${ClaudeSystemSubtype.ThinkingTokens}`]: {
    emits: [AgentEventType.ThinkingProgress],
    note: "a running estimate of the open thinking block",
  },
  [`${ClaudeWireType.System}/${ClaudeSystemSubtype.HookStarted}`]: {
    emits: [AgentEventType.Hook],
    note: "a hook began",
  },
  [`${ClaudeWireType.System}/${ClaudeSystemSubtype.HookResponse}`]: {
    emits: [AgentEventType.Hook],
    note: "a hook finished, with its outcome and exit code",
  },
  [`${ClaudeWireType.System}/${ClaudeSystemSubtype.PostTurnSummary}`]: {
    emits: [AgentEventType.PostTurnSummary],
    note: "a one-line recap emitted just before the turn's result",
  },
  [`${ClaudeWireType.System}/${ClaudeSystemSubtype.CompactBoundary}`]: {
    emits: [AgentEventType.ContextCompacted],
    note: "the seam where a compaction dropped the earlier conversation",
  },
  [`${ClaudeWireType.System}/${ClaudeSystemSubtype.PermissionDenied}`]: {
    emits: [AgentEventType.PermissionDenied],
    note: "a call refused without being asked about",
  },
  [ClaudeWireType.Attachment]: {
    emits: [AgentEventType.Unknown],
    note: "the CLI's own bookkeeping in a saved transcript — a deferred tool list, not a turn; carried as unknown so the raw line survives",
  },
  [ClaudeWireType.RateLimit]: {
    emits: [AgentEventType.RateLimited],
    note: "only when a limit is reached or overage is in use; the steady state emits nothing",
  },

  // ---------- asks ----------
  [`${ClaudeWireType.ControlRequest}/can_use_tool`]: {
    emits: [AgentEventType.PermissionRequested],
    note: "the one duplex exchange: the harness blocks until it is answered, and the reply is written back on stdin",
  },
  [ClaudeWireType.ControlResponse]: {
    emits: [AgentEventType.PermissionDecided],
    note: "retires a pending ask and records which way it went; neither direction carries a timestamp",
  },
})

/**
 * Claude's task vocabulary, mapped to ours.
 *
 * A lookup rather than a chain of comparisons: the mapping *is* data, and
 * written as data it can be read at a glance, exhaustively checked by the
 * compiler against the provider's own union, and extended without touching
 * control flow. `Other` is the fallback for a kind a later release invents.
 */
export const CLAUDE_TASK_KIND: Readonly<Record<ClaudeTaskType, TaskKind>> = Object.freeze({
  [ClaudeTaskType.Agent]: TaskKind.Agent,
  [ClaudeTaskType.Workflow]: TaskKind.Workflow,
  [ClaudeTaskType.Bash]: TaskKind.Bash,
})

/** Claude's plan-step words, mapped to ours. Anything unrecognized is still pending. */
export const CLAUDE_PLAN_STATUS: Readonly<Record<string, PlanStepStatus>> = Object.freeze({
  pending: PlanStepStatus.Pending,
  in_progress: PlanStepStatus.InProgress,
  completed: PlanStepStatus.Completed,
})

/** Reads a `task_type` off the wire as one of ours. */
export function claudeTaskKind(taskType: string | null): TaskKind {
  if (taskType === null) return TaskKind.Other
  return CLAUDE_TASK_KIND[taskType as ClaudeTaskType] ?? TaskKind.Other
}

/** Reads a plan step's status off the wire as one of ours. */
export function claudePlanStatus(status: string | null): PlanStepStatus {
  if (status === null) return PlanStepStatus.Pending
  return CLAUDE_PLAN_STATUS[status] ?? PlanStepStatus.Pending
}

/**
 * The mapping key for one decoded line.
 *
 * Mirrors the granularity the table is written at, so a caller can look up what
 * a line is supposed to produce — which is what the test suite does, and what a
 * host would do to explain an event to a reader.
 */
export function claudeWireKind(event: WireEvent): ClaudeWireKind {
  const line = asRecord(event as unknown as JsonValue)
  const type = asString(line.type) ?? "unknown"

  if (type === ClaudeWireType.StreamEvent) {
    const frame = asRecord(line.event)
    const frameType = asString(frame.type) ?? "unknown"
    if (frameType !== ClaudeStreamFrameType.ContentBlockDelta) return `${type}/${frameType}`
    return `${type}/${frameType}/${asString(asRecord(frame.delta).type) ?? "unknown"}`
  }

  if (type === ClaudeWireType.Assistant || type === ClaudeWireType.User) {
    // A `user` line's content is one of two unrelated shapes and nothing labels
    // which — a bare string is what the human typed, an array is what the CLI
    // fed back — so the shape itself is the discriminator.
    const content = asRecord(line.message).content
    const text = asString(content)
    if (text !== null) return `${type}/text`
    const blocks = Array.isArray(content) ? content : []
    if (blocks.length === 0) return `${type}/empty`
    return `${type}/${asString(asRecord(blocks[0]).type) ?? "unknown"}`
  }

  if (type === ClaudeWireType.System) {
    return `${type}/${asString(line.subtype) ?? "unknown"}`
  }

  if (type === ClaudeWireType.ControlRequest) {
    return `${type}/${asString(asRecord(line.request).subtype) ?? "unknown"}`
  }

  return type
}

/** What a line kind is declared to produce, or null for a kind nobody has decided about. */
export function claudeMappingFor(kind: ClaudeWireKind): ClaudeMappingEntry | null {
  return CLAUDE_EVENT_MAPPING[kind] ?? null
}
