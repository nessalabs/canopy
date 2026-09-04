/** @responsibility Describes Claude Code's `stream-json` wire shapes and decodes one line into them without interpreting it. */

import { parseJsonLine } from "../../json"
import type { JsonValue } from "../../json"
import type { WireProvenance } from "../../events"

/**
 * The build these shapes were read from.
 *
 * Claude Code stamps its own version on this stream — `system/init` carries it
 * — so a consumer can compare what it is reading against this and know when the
 * two have drifted apart. Its other two transports are elsewhere: the duplex
 * mode is this same wire with stdin open, and ACP is a different protocol
 * entirely, read by `acp/`.
 */
export const CLAUDE_STREAM_PROVENANCE: WireProvenance = Object.freeze({
  cli: "Claude Code",
  /**
   * The newest build any checked-in capture came from.
   *
   * The fixtures span two: the approval and compaction captures are 2.1.251,
   * the earlier ones 2.1.233. Nothing about the shapes differed between them —
   * which is only knowable because this wire stamps its own version on
   * `system/init`, and a test compares the two.
   */
  version: "2.1.251",
  command: "claude -p --output-format stream-json --include-partial-messages --verbose",
  capturedOn: "2026-08-29",
})

/** Re-exported so one import gives a consumer this wire's whole vocabulary. */
export type { JsonValue }

/**
 * The line kinds Claude Code emits.
 *
 * Provider-specific by design: this is Claude Code's vocabulary, and a Codex or
 * ACP wire module declares its own. Frozen object plus derived union rather
 * than a TypeScript `enum` — an `enum` is a nominal type that does not survive
 * JSON, so a value read off the wire could never *be* one without a cast, which
 * is the opposite of what naming them is for.
 */
export const ClaudeWireType = Object.freeze({
  System: "system",
  StreamEvent: "stream_event",
  Assistant: "assistant",
  User: "user",
  Result: "result",
  RateLimit: "rate_limit_event",
  /**
   * The CLI's own bookkeeping, written into a saved transcript.
   *
   * Not part of the conversation: a `deferred_tools_delta` naming tools that
   * became available mid-session. It reaches a consumer as `unknown` with the
   * raw line attached rather than being dropped.
   */
  Attachment: "attachment",
  ControlRequest: "control_request",
  ControlResponse: "control_response",
} as const)

export type ClaudeWireType = (typeof ClaudeWireType)[keyof typeof ClaudeWireType]

/**
 * The `system` subtypes this build models.
 *
 * Naming them does not close the set: the CLI adds subtypes between releases
 * (`thinking_tokens` arrived unannounced), so a parser matches on these and
 * lets everything else fall through to an `unknown` event rather than failing
 * the line. The union is a checklist of what is handled, not a claim about what
 * exists.
 */
export const ClaudeSystemSubtype = Object.freeze({
  Init: "init",
  Status: "status",
  TaskStarted: "task_started",
  TaskProgress: "task_progress",
  TaskUpdated: "task_updated",
  TaskNotification: "task_notification",
  TaskSummary: "task_summary",
  ThinkingTokens: "thinking_tokens",
  HookStarted: "hook_started",
  HookResponse: "hook_response",
  PostTurnSummary: "post_turn_summary",
  BackgroundTasksChanged: "background_tasks_changed",
  CompactBoundary: "compact_boundary",
  PermissionDenied: "permission_denied",
} as const)

export type ClaudeSystemSubtype = (typeof ClaudeSystemSubtype)[keyof typeof ClaudeSystemSubtype]

/** The Anthropic SSE frame types carried inside `stream_event.event`. */
export const ClaudeStreamFrameType = Object.freeze({
  MessageStart: "message_start",
  ContentBlockStart: "content_block_start",
  ContentBlockDelta: "content_block_delta",
  ContentBlockStop: "content_block_stop",
  MessageDelta: "message_delta",
  MessageStop: "message_stop",
} as const)

export type ClaudeStreamFrameType = (typeof ClaudeStreamFrameType)[keyof typeof ClaudeStreamFrameType]

/** The delta kinds an open content block streams. */
export const ClaudeContentDeltaType = Object.freeze({
  Text: "text_delta",
  Thinking: "thinking_delta",
  Signature: "signature_delta",
  InputJson: "input_json_delta",
} as const)

export type ClaudeContentDeltaType = (typeof ClaudeContentDeltaType)[keyof typeof ClaudeContentDeltaType]

/**
 * The kinds of delegated work a `task_started` announces.
 *
 * `local_bash` is a backgrounded shell rather than an agent, which is why it
 * carries no `subagent_type` and reports no usage.
 */
export const ClaudeTaskType = Object.freeze({
  Agent: "local_agent",
  Workflow: "local_workflow",
  Bash: "local_bash",
} as const)

export type ClaudeTaskType = (typeof ClaudeTaskType)[keyof typeof ClaudeTaskType]

/** The content block kinds, shared by the streamed and committed positions. */
export const ClaudeContentBlockType = Object.freeze({
  Text: "text",
  Thinking: "thinking",
  ToolUse: "tool_use",
  ToolResult: "tool_result",
  Image: "image",
} as const)

export type ClaudeContentBlockType = (typeof ClaudeContentBlockType)[keyof typeof ClaudeContentBlockType]

/**
 * Anthropic's token accounting. Present on `result`, on committed `assistant`
 * messages, and on the `message_start`/`message_delta` stream frames — but with
 * different fields filled in each place, so everything past the four counts is
 * optional.
 */
export interface WireUsage {
  readonly input_tokens?: number
  readonly output_tokens?: number
  readonly cache_read_input_tokens?: number
  readonly cache_creation_input_tokens?: number
  readonly cache_creation?: {
    readonly ephemeral_5m_input_tokens?: number
    readonly ephemeral_1h_input_tokens?: number
  }
  readonly server_tool_use?: {
    readonly web_search_requests?: number
    readonly web_fetch_requests?: number
  }
  readonly service_tier?: string
  readonly speed?: string
  /**
   * Per-request breakdown when one turn took several model calls. Sent as an
   * explicit `null` on the CLI's synthetic messages, so consumers must treat
   * "present but null" as "absent" rather than trusting the key.
   */
  readonly iterations?: readonly WireUsage[] | null
}

/** A content block, identical in the streamed and committed positions. */
export type WireContentBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "thinking"
      readonly thinking?: string
      readonly signature?: string
    }
  | {
      readonly type: "tool_use"
      readonly id: string
      readonly name: string
      readonly input?: JsonValue
      readonly caller?: JsonValue
    }
  | { readonly type: string; readonly [key: string]: JsonValue | undefined }

/** One incremental update to an open content block. */
export type WireContentDelta =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "thinking_delta"; readonly thinking: string }
  | { readonly type: "signature_delta"; readonly signature: string }
  /**
   * Fragments of a tool call's arguments. These are *not* individually
   * parseable — only the concatenation of every fragment for one block is
   * valid JSON.
   */
  | { readonly type: "input_json_delta"; readonly partial_json: string }
  | { readonly type: string }

/**
 * One Anthropic SSE frame, as carried inside `stream_event.event`. Blocks are
 * addressed by `index` within the message opened by `message_start`; a block's
 * identity arrives once, up front, in `content_block_start`.
 */
export type WireStreamFrame =
  | {
      readonly type: "message_start"
      readonly message: {
        readonly id: string
        readonly model: string
        readonly role: string
        readonly usage?: WireUsage
      }
    }
  | {
      readonly type: "content_block_start"
      readonly index: number
      readonly content_block: WireContentBlock
    }
  | {
      readonly type: "content_block_delta"
      readonly index: number
      readonly delta: WireContentDelta
    }
  | { readonly type: "content_block_stop"; readonly index: number }
  | {
      readonly type: "message_delta"
      readonly delta: { readonly stop_reason?: string | null }
      readonly usage?: WireUsage
    }
  | { readonly type: "message_stop" }
  | { readonly type: string }

/** A tool result's payload: one flat string, or a block array for structured tools. */
export type WireToolResultContent = string | readonly WireContentBlock[]

/** A `user` line's message. Human prompts arrive as a bare string; everything the CLI feeds back arrives as blocks. */
export interface WireUserMessage {
  readonly role: "user"
  readonly content: string | readonly WireContentBlock[]
}

/** A committed `assistant` message. Claude Code sends one line per content block, so `content` has length 1. */
export interface WireAssistantMessage {
  readonly id: string
  readonly model: string
  readonly role: "assistant"
  readonly content: readonly WireContentBlock[]
  readonly stop_reason?: string | null
  readonly usage?: WireUsage
}

/** Usage reported for one background task or workflow run. */
export interface WireTaskUsage {
  readonly total_tokens?: number
  readonly tool_uses?: number
  readonly duration_ms?: number
}

/** What one `system/init` advertises: the whole session, as the CLI sees it. */
export interface WireInitEvent {
  readonly type: "system"
  readonly subtype: "init"
  readonly session_id: string
  readonly cwd: string
  readonly model: string
  readonly tools: readonly string[]
  readonly slash_commands?: readonly string[]
  readonly terminal_slash_commands?: readonly string[]
  readonly skills?: readonly string[]
  readonly agents?: readonly string[]
  readonly mcp_servers?: readonly { readonly name: string; readonly status: string }[]
  readonly plugins?: readonly { readonly name: string; readonly version?: string; readonly source?: string }[]
  readonly permissionMode?: string
  readonly output_style?: string
  readonly claude_code_version?: string
}

/** A delegated run beginning: a subagent, a workflow, or a backgrounded shell. */
export interface WireTaskStartedEvent {
  readonly type: "system"
  readonly subtype: "task_started"
  readonly task_id: string
  readonly tool_use_id: string
  readonly task_type: string
  readonly description?: string
  readonly subagent_type?: string
  readonly workflow_name?: string
  readonly prompt?: string
}

/**
 * A delegated run's live status.
 *
 * `workflow_progress` rides only some of these, and is the only window into a
 * workflow's agents — they write nothing else to the stream.
 */
export interface WireTaskProgressEvent {
  readonly type: "system"
  readonly subtype: "task_progress"
  readonly task_id: string
  readonly tool_use_id: string
  readonly description?: string
  readonly last_tool_name?: string
  readonly usage?: { readonly total_tokens?: number; readonly tool_uses?: number; readonly duration_ms?: number }
  readonly workflow_progress?: readonly JsonValue[]
}

/** A delegated run finishing, with where its output was written. */
export interface WireTaskNotificationEvent {
  readonly type: "system"
  readonly subtype: "task_notification"
  readonly task_id: string
  readonly tool_use_id?: string
  readonly status?: string
  readonly summary?: string
  readonly output_file?: string
}

/** The seam a compaction left, and what it cost. */
export interface WireCompactBoundaryEvent {
  readonly type: "system"
  readonly subtype: "compact_boundary"
  readonly compact_metadata?: {
    readonly trigger?: string
    readonly pre_tokens?: number
    readonly post_tokens?: number
  }
}

/** A call refused without ever being asked about. */
export interface WirePermissionDeniedEvent {
  readonly type: "system"
  readonly subtype: "permission_denied"
  readonly tool_name: string
  readonly tool_use_id: string
  readonly message?: string
}

/** A hook running. `hook_response` adds the outcome. */
export interface WireHookEvent {
  readonly type: "system"
  readonly subtype: "hook_started" | "hook_response"
  readonly hook_name?: string
  readonly hook_event?: string
  readonly outcome?: string
  readonly exit_code?: number
}

/** A system line this build does not model. Open on purpose: the CLI adds subtypes. */
export interface WireUnknownSystemEvent {
  readonly type: "system"
  readonly subtype: string
  readonly [key: string]: JsonValue | undefined
}

/** Everything the `system` channel can carry. */
export type WireSystemEvent =
  | WireInitEvent
  | WireTaskStartedEvent
  | WireTaskProgressEvent
  | WireTaskNotificationEvent
  | WireCompactBoundaryEvent
  | WirePermissionDeniedEvent
  | WireHookEvent
  | WireUnknownSystemEvent

/** Any decoded line, before anything past `type` has been checked. */
export interface WireLine {
  readonly type: string
  readonly [key: string]: JsonValue | undefined
}

/**
 * One decoded line. Every arm keeps the fields this library reads and tolerates
 * the rest: the CLI adds keys and whole subtypes between releases, and a parser
 * that fails a line over an unknown field loses content it could have shown.
 *
 * These shapes describe the wire; they do not police it. A declared type is a
 * claim about bytes, not a check on them, so the mapper reads every field
 * through the shared readers rather than trusting the declaration.
 */
export type WireEvent =
  | WireSystemEvent
  | {
      readonly type: "stream_event"
      readonly event: WireStreamFrame
      readonly session_id: string
      readonly uuid: string
      readonly parent_tool_use_id?: string | null
    }
  | {
      readonly type: "assistant"
      readonly message: WireAssistantMessage
      readonly session_id: string
      readonly uuid: string
      readonly parent_tool_use_id?: string | null
      readonly subagent_type?: string | null
      readonly task_description?: string | null
    }
  | {
      readonly type: "user"
      readonly message: WireUserMessage
      readonly session_id: string
      readonly uuid: string
      readonly timestamp?: string
      readonly parent_tool_use_id?: string | null
      readonly tool_use_result?: JsonValue
      readonly subagent_type?: string | null
      readonly task_description?: string | null
      readonly isReplay?: boolean
      readonly isSynthetic?: boolean
    }
  | {
      readonly type: "result"
      readonly subtype: string
      readonly session_id: string
      readonly uuid?: string
      readonly [key: string]: JsonValue | undefined
    }
  | {
      readonly type: "rate_limit_event"
      readonly rate_limit_info: {
        readonly status?: string
        readonly resetsAt?: number
        readonly rateLimitType?: string
        readonly overageStatus?: string
        readonly overageDisabledReason?: string
        readonly isUsingOverage?: boolean
      }
      readonly session_id: string
      readonly uuid: string
    }
  | {
      readonly type: "control_request"
      readonly request_id: string
      readonly request: { readonly subtype: string; readonly [key: string]: JsonValue | undefined }
    }
  | { readonly type: "control_response"; readonly response: JsonValue }
  | { readonly type: string; readonly [key: string]: JsonValue | undefined }

/** What a line that could not be decoded at all becomes. */
export interface WireParseFailure {
  readonly ok: false
  readonly line: string
  readonly reason: string
}

export interface WireParseSuccess {
  readonly ok: true
  /**
   * What the parser actually verified: an object with a string `type`.
   *
   * Not one of the arms above. Returning the union would claim fields nothing
   * checked; the arms describe the wire, and a consumer narrows to one after
   * checking, the way this package's own mapper does.
   */
  readonly line: WireLine
}

export type WireParseResult = WireParseSuccess | WireParseFailure

/**
 * Decodes one line of Claude Code's `--output-format stream-json` stream.
 *
 * Failure is returned rather than thrown: a stream is read for as long as the
 * process runs, and one malformed line — a truncated write, a stray log — must
 * not end the transcript. Blank lines are a failure with an explicit reason so
 * a caller can filter them knowingly instead of by accident. The decoding
 * itself is shared — every provider's wire is newline-delimited JSON — and
 * what stays here is the naming and the return type.
 */
export function parseWireLine(line: string): WireParseResult {
  const result = parseJsonLine(line)
  return result.ok ? { ok: true, line: result.line as WireLine } : result
}

/** Decodes a whole capture, keeping failures in place. */
export function parseWireLines(text: string): readonly WireParseResult[] {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map(parseWireLine)
}
