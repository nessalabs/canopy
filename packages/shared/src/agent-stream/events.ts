/** @responsibility Defines the harness-agnostic event model that agent transcript UI renders against. */

import type { JsonValue } from "./json"

/**
 * Where an event happened in the agent tree.
 *
 * `[]` is the main conversation. Each further element is the id of the tool
 * call that spawned the next level down, so a subagent that spawns its own
 * subagent produces `[outerCallId, innerCallId]`. A single id would only be
 * able to say *which* run an event belongs to, never how deep it sits, and
 * retrofitting the depth once components read a flat id is expensive — so the
 * path is a list from the start even though most captures are one level deep.
 */
export type AgentPath = readonly string[]

/**
 * Joins streamed content to its committed counterpart.
 *
 * Claude Code's committed `assistant` lines carry no block index — it emits one
 * line per content block, several sharing a message id — so the index is
 * derived by counting blocks per message in arrival order. Getting it wrong
 * attaches streamed text to the wrong block, silently.
 */
export interface BlockRef {
  readonly messageId: string
  readonly index: number
}

/** A rendering hint. Nothing depends on it for correctness, and `other` must always render acceptably. */
export type ToolKind =
  | "shell"
  | "file_read"
  | "file_edit"
  | "search"
  | "web"
  | "mcp"
  | "plan"
  | "subagent"
  | "workflow"
  | "other"

/** What a tool call handed back. */
export interface ToolResult {
  /** Result content flattened to text; the wire alternates between a bare string and a block array. */
  readonly text: string
  /** Harnesses omit this on success rather than sending `false`, so absence means "fine". */
  readonly isError: boolean
  /** The `tool_use_result` sidecar, when the CLI sent one. Richer than `text` for structured tools. */
  readonly structured: JsonValue | null
  /** Images the tool returned, as `data:` URLs. */
  readonly images: readonly string[]
}

/** Where a plan step stands. Shared across providers; each maps its own words onto it. */
export const PlanStepStatus = Object.freeze({
  Pending: "pending",
  InProgress: "in_progress",
  Completed: "completed",
} as const)

export type PlanStepStatus = (typeof PlanStepStatus)[keyof typeof PlanStepStatus]

/**
 * One step of the agent's own plan.
 *
 * Two tools produce these and they disagree about shape: `TodoWrite` republishes
 * the whole list on every call, while `TaskCreate`/`TaskUpdate` add and patch one
 * step at a time and put the step's id only in the *tool result text*
 * ("Task #2 created successfully"). `id` is null for the republishing shape,
 * which needs none.
 */
export interface PlanStep {
  readonly id: string | null
  readonly content: string
  readonly status: PlanStepStatus
  readonly activeForm?: string
}

/**
 * One agent inside a workflow run, as `task_progress.workflow_progress`
 * reports it.
 *
 * A workflow's agents never write their own events to the stream — no line
 * carries their `parent_tool_use_id` — so this snapshot is the *only* window
 * into them. It is rich enough to be a real view: which phase each agent
 * belongs to, what it was asked, whether it is queued, running or done, what it
 * cost, and a preview of what it returned.
 */
export interface WorkflowAgentProgress {
  /** Position within the run, which is also the stable identity across snapshots. */
  readonly index: number
  readonly label: string
  readonly phaseIndex: number
  readonly phaseTitle: string
  /** The harness's handle, absent until the agent actually starts. */
  readonly agentId: string | null
  readonly model: string | null
  /**
   * The wire's own word, passed through.
   *
   * Observed: `start` (queued or running), `progress`, and `done`, which is
   * terminal. Passed through rather than normalized because the vocabulary is
   * the harness's and it has already grown once — a consumer should treat any
   * unrecognised value as "not finished" rather than as unknown.
   */
  readonly state: string
  readonly queuedAt: number | null
  readonly startedAt: number | null
  readonly attempt: number | null
  /** The opening of the prompt the agent was given. */
  readonly promptPreview: string | null
  /** The opening of what it returned, present once it is done. */
  readonly resultPreview: string | null
  readonly tokens: number | null
  readonly toolCalls: number | null
  readonly durationMs: number | null
}

/** One phase of a workflow, in declaration order. */
export interface WorkflowPhaseProgress {
  readonly index: number
  readonly title: string
  readonly agents: readonly WorkflowAgentProgress[]
}

/**
 * What kind of delegated work a run is.
 *
 * Ours, not a provider's: `agent` is a run that reports its own events,
 * `workflow` one that reports a board instead, `bash` a backgrounded shell.
 * Each provider maps its own vocabulary onto these.
 */
export const TaskKind = Object.freeze({
  Agent: "agent",
  Workflow: "workflow",
  Bash: "bash",
  Other: "other",
} as const)

export type TaskKind = (typeof TaskKind)[keyof typeof TaskKind]

/** How a file changed. Shared: every provider that reports edits reports one of these. */
export const FileChange = Object.freeze({
  Add: "add",
  Update: "update",
  Delete: "delete",
  Rename: "rename",
} as const)

export type FileChange = (typeof FileChange)[keyof typeof FileChange]

/** One file an agent touched. */
export interface FileEdit {
  readonly path: string
  readonly change: FileChange
  /** A unified diff when the provider supplies one; Codex reports paths only. */
  readonly unifiedDiff: string | null
}

/** How a turn ended. */
export type TurnStatus = "completed" | "interrupted" | "error"

/**
 * Token accounting, normalized across the places a wire reports it.
 *
 * Every counter is optional because providers report usage at different
 * granularities and a parser that fills the gaps with zeros is lying: a task's
 * progress line carries one total and no breakdown, and rendering that as
 * "0 in / 38k out" states something the wire never said. `totalTokens` is the
 * one figure every reporter has; read the breakdown only when it is present.
 */
export interface Usage {
  readonly totalTokens: number | null
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly cacheReadTokens: number | null
  readonly cacheCreationTokens: number | null
  /**
   * Tokens spent reasoning, where a provider counts them separately.
   *
   * Codex reports this; Claude Code folds reasoning into its output count and
   * reports none. Null therefore means "not reported", never "none spent", and
   * a total that includes it must not also add it twice.
   */
  readonly reasoningTokens: number | null
  readonly totalCostUsd?: number
}

/**
 * Which build of a CLI a provider's wire description was read from.
 *
 * These shapes are not a published contract — all three CLIs change their
 * output between releases, and two of the three do so without a version field
 * anywhere on the stream. A mapper is therefore only true of the build it was
 * captured from, and saying which one is the difference between a parser a
 * maintainer can re-verify and one that quietly rots.
 *
 * When a capture is retaken against a newer build, update `version` and
 * `capturedOn` in the same commit as the fixtures. If nothing changed, that is
 * itself the finding worth recording.
 */
export interface WireProvenance {
  /** The CLI as it names itself. */
  readonly cli: string
  /** The exact build the checked-in fixtures were recorded from. */
  readonly version: string
  /** The command that produces this wire, so the capture can be repeated. */
  readonly command: string
  /** ISO date of the capture, in UTC. */
  readonly capturedOn: string
}

/** What one `system/init` said the session was configured with. */
export interface SessionInfo {
  /** The only field every provider asserts. */
  readonly sessionId: string
  /**
   * Null where the provider does not say.
   *
   * Codex's thread line carries an id and nothing else, so filling these with
   * `"unknown"` would put a placeholder on screen and state something the wire
   * never did — the same reason the token counters are nullable.
   */
  readonly model: string | null
  readonly cwd: string | null
  readonly tools: readonly string[]
  readonly slashCommands: readonly string[]
  readonly agents: readonly string[]
  readonly skills: readonly string[]
  readonly mcpServers: readonly { readonly name: string; readonly status: string }[]
  /** Commands the terminal owns rather than the session (`/doctor`, `/color`). */
  readonly terminalSlashCommands: readonly string[]
  readonly plugins: readonly { readonly name: string; readonly version: string | null; readonly source: string }[]
  readonly permissionMode: string | null
  readonly version: string | null
  readonly outputStyle: string | null
  /**
   * Which `init` this is within the mapped stream, counting from zero.
   *
   * **A resumed session is not detectable from the stream.** `init` is emitted
   * per turn rather than per process — a single workflow run emits two — and a
   * resumed process reuses the session id and replays none of the earlier
   * turns, so a second `init` proves nothing on its own. Only the host, which
   * chose whether to pass `--resume`, knows; what the stream *can* prove is a
   * model change between two inits, which is reported separately as
   * `model_changed`.
   */
  readonly initIndex: number
}

/** Incremental content for one block. Always a preview: the committed event for the same `BlockRef` supersedes it. */
export type DeltaPayload =
  /**
   * Split by block kind rather than carrying correlated optionals: a single
   * variant with `blockType` plus `toolId?`/`toolName?` also describes
   * `{ blockType: "tool_use" }` with neither, and a consumer drawing a tool
   * chip would have to write a fallback for a case that should be impossible.
   */
  | { readonly delta: "block_start"; readonly block: BlockRef; readonly blockType: "text" | "thinking" }
  | {
      readonly delta: "block_start"
      readonly block: BlockRef
      readonly blockType: "tool_use"
      readonly toolId: string
      readonly toolName: string
    }
  | { readonly delta: "text"; readonly block: BlockRef; readonly text: string }
  | { readonly delta: "input"; readonly block: BlockRef; readonly partialJson: string }
  | { readonly delta: "block_stop"; readonly block: BlockRef }

/**
 * A tool the operator refused, as summarised on the turn's own result. It
 * repeats what the ask already said, which is what lets a consumer show a
 * refusal on a transcript replayed from the result alone.
 */
export interface PermissionDenial {
  readonly toolName: string
  readonly callId: string
  readonly input: JsonValue
}

/** What happened. */
export type AgentEventPayload =
  // ---------- session and turn lifecycle ----------
  /**
   * One `init`. There is deliberately no separate "turn started" variant: the
   * CLI emits `init` per *turn*, not per session, so a second variant would
   * describe the same line twice and a consumer switching on it would be
   * waiting for something that never arrives.
   */
  | { readonly type: "session_started"; readonly session: SessionInfo }
  /**
   * Derived, not sent: the CLI has no "model changed" line, so this is the
   * mapper noticing that a new `init` for a session it already knows names a
   * different model — which is exactly what `--model` on a resume looks like.
   */
  | { readonly type: "model_changed"; readonly from: string; readonly to: string }
  | {
      readonly type: "turn_completed"
      readonly status: TurnStatus
      readonly stopReason: string | null
      readonly terminalReason: string | null
      readonly finalText: string | null
      readonly usage: Usage | null
      readonly durationMs: number | null
      readonly numTurns: number | null
      /**
       * What the operator refused during the turn. Present and empty on a
       * clean run, so an empty list means "nothing was refused" rather than
       * "the harness does not report refusals".
       */
      readonly permissionDenials: readonly PermissionDenial[]
    }
  // ---------- conversation ----------
  | { readonly type: "user_message"; readonly text: string; readonly synthetic: boolean }
  | { readonly type: "assistant_text"; readonly text: string; readonly block: BlockRef | null }
  | { readonly type: "reasoning"; readonly text: string; readonly block: BlockRef | null }
  | ({ readonly type: "delta" } & DeltaPayload)
  // ---------- tools ----------
  | {
      readonly type: "tool_call_started"
      readonly callId: string
      readonly name: string
      readonly kind: ToolKind
      readonly input: JsonValue
      /** One line naming what the call does, derived from its own arguments. */
      readonly title: string
    }
  | { readonly type: "tool_call_completed"; readonly callId: string; readonly result: ToolResult }
  /**
   * Files an agent changed, reported as structure rather than as prose.
   *
   * Only some providers report this: Codex publishes the touched paths and how
   * each changed, while Claude Code surfaces the same work as ordinary file
   * tool calls a consumer would have to parse. A view that wants a changed-file
   * list reads this where it exists and falls back to tool calls where it does
   * not — the absence is a property of the provider, not an error.
   */
  | { readonly type: "file_edits"; readonly callId: string | null; readonly edits: readonly FileEdit[] }
  /**
   * The agent's plan, republished whole. Latest wins — consumers replace rather
   * than accumulate.
   */
  | { readonly type: "plan_updated"; readonly steps: readonly PlanStep[] }
  // ---------- delegated work ----------
  | {
      readonly type: "task_started"
      readonly taskId: string
      readonly callId: string
      readonly taskKind: TaskKind
      readonly label: string | null
      readonly description: string
      readonly prompt: string | null
      /**
       * The delegated run's own transcript, where the provider names one.
       *
       * opencode puts the child session id on the call itself, and
       * `opencode export <id>` reads it — so its delegated work is readable
       * without deriving anything. Claude's subagent transcripts have to be
       * located on disk instead (see `claude/store`), and Codex names threads
       * it never lets you read, so both send null here.
       */
      readonly transcriptId: string | null
    }
  | {
      readonly type: "task_progress"
      readonly taskId: string
      readonly callId: string
      /** Rewritten per event by the harness, so it drives a live status line. */
      readonly description: string
      readonly lastTool: string | null
      readonly usage: Usage | null
    }
  /**
   * A workflow's phase-and-agent board, republished whole on every update.
   * Latest wins; consumers replace rather than merge.
   */
  | {
      readonly type: "workflow_progress"
      readonly taskId: string
      readonly callId: string
      readonly phases: readonly WorkflowPhaseProgress[]
    }
  | {
      readonly type: "task_completed"
      readonly taskId: string
      readonly callId: string | null
      readonly status: string
      readonly summary: string | null
      readonly usage: Usage | null
    }
  // ---------- session-level reports ----------
  | { readonly type: "status_changed"; readonly status: string | null; readonly permissionMode: string | null }
  /** A one-line gloss of what the agent is doing, emitted alongside a tool call. */
  | { readonly type: "activity"; readonly detail: string }
  | { readonly type: "thinking_progress"; readonly tokens: number }
  | {
      readonly type: "hook"
      readonly phase: "started" | "finished"
      readonly name: string
      readonly event: string
      readonly outcome: string | null
      readonly exitCode: number | null
    }
  | {
      readonly type: "post_turn_summary"
      readonly category: string
      readonly detail: string
      readonly needsAction: string | null
    }
  | {
      readonly type: "rate_limited"
      readonly status: string
      readonly resetsAt: string | null
      readonly window: string | null
      readonly usingOverage: boolean
    }
  | {
      readonly type: "context_compacted"
      /** `auto` when the window filled on its own, `manual` when asked for. */
      readonly trigger: string | null
      readonly preTokens: number | null
      readonly postTokens: number | null
      /**
       * What has been dropped across the whole session, not just this
       * boundary — it keeps climbing as a long session compacts repeatedly,
       * which is what makes it the honest measure of how much the agent can no
       * longer see.
       */
      readonly droppedTokens: number | null
      /** Compaction is a model call of its own, and a slow one. */
      readonly durationMs: number | null
    }
  | { readonly type: "background_tasks_changed"; readonly tasks: readonly { readonly taskId: string; readonly description: string }[] }
  // ---------- asks ----------
  | {
      readonly type: "permission_requested"
      readonly requestId: string
      readonly callId: string
      readonly toolName: string
      /** What the tool would run with. The ask is worth nothing without it. */
      readonly input: JsonValue
      /** Why the harness escalated — a settings rule, a mode, a hook. */
      readonly reason: string | null
      /** The harness's own label for the tool, when it differs from the name. */
      readonly displayName: string | null
      /** The agent's one-line account of what it is about to do. */
      readonly description: string | null
    }
  | {
      readonly type: "permission_decided"
      readonly requestId: string
      /**
       * Which way it went. Null when the answer came back in a shape we could
       * not read — the ask is retired either way, but a consumer must not draw
       * an unknown answer as an approval.
       */
      readonly decision: "allow" | "deny" | null
      /** The reason given for a refusal, which becomes the tool's error text. */
      readonly message: string | null
    }
  | { readonly type: "permission_denied"; readonly callId: string; readonly toolName: string; readonly message: string }
  // ---------- fallbacks ----------
  | { readonly type: "error"; readonly message: string }
  /**
   * A line understood well enough to place in the transcript but not to model.
   * Carrying it — with `raw` on the envelope — is what keeps a consumer honest
   * about an evolving CLI instead of silently dropping subtypes.
   */
  | { readonly type: "unknown"; readonly wireType: string; readonly subtype: string | null }

/**
 * Every payload kind, as values.
 *
 * **Deliberately not per-provider, and this is the load-bearing decision.** The
 * discriminator is the shared contract: a component switches on
 * `payload.type`, and if that vocabulary were Claude's, a Codex or ACP session
 * would need its own components rather than its own mapper. Provider-specific
 * vocabularies live one layer down, in each wire module (`ClaudeWireType`,
 * `ClaudeSystemSubtype`, …), which is where a name *should* be provider-shaped.
 *
 * Given as a frozen object as well as a union so consumers can reference a kind
 * by name — `AgentEventType.ToolCallStarted` — instead of retyping a string
 * literal. The values are the literals themselves, so the two are
 * interchangeable and both survive JSON.
 */
export const AgentEventType = Object.freeze({
  SessionStarted: "session_started",
  ModelChanged: "model_changed",
  TurnCompleted: "turn_completed",
  UserMessage: "user_message",
  AssistantText: "assistant_text",
  Reasoning: "reasoning",
  Delta: "delta",
  ToolCallStarted: "tool_call_started",
  ToolCallCompleted: "tool_call_completed",
  PlanUpdated: "plan_updated",
  FileEdits: "file_edits",
  TaskStarted: "task_started",
  TaskProgress: "task_progress",
  TaskCompleted: "task_completed",
  WorkflowProgress: "workflow_progress",
  StatusChanged: "status_changed",
  Activity: "activity",
  ThinkingProgress: "thinking_progress",
  Hook: "hook",
  PostTurnSummary: "post_turn_summary",
  RateLimited: "rate_limited",
  ContextCompacted: "context_compacted",
  BackgroundTasksChanged: "background_tasks_changed",
  PermissionRequested: "permission_requested",
  PermissionDecided: "permission_decided",
  PermissionDenied: "permission_denied",
  Error: "error",
  Unknown: "unknown",
} as const)

export type AgentEventType = (typeof AgentEventType)[keyof typeof AgentEventType]

/**
 * Narrows an event to one payload kind.
 *
 * `event.payload.type === "tool_call_started"` narrows just as well; this is
 * for the places where the check and the use are apart — a `filter` that should
 * hand back a typed array, say.
 */
export function isEvent<T extends AgentEventType>(
  event: AgentEvent,
  type: T,
): event is AgentEvent & { payload: Extract<AgentEventPayload, { type: T }> } {
  return event.payload.type === type
}

/** One normalized event: an envelope saying who and in what order, wrapping a payload saying what. */
export interface AgentEvent {
  readonly id: string
  readonly sessionId: string
  /**
   * Position in the session's log, and the only ordering key.
   *
   * Most Claude Code lines carry no timestamp, so sorting by time silently
   * scrambles a transcript. One counter per mapper, shared by every path.
   */
  readonly seq: number
  readonly ts: string | null
  readonly agentPath: AgentPath
  readonly payload: AgentEventPayload
  /** The line this came from, kept so a raw view and an `unknown` payload stay useful. */
  readonly raw: JsonValue
}

/**
 * What every provider's mapper implements.
 *
 * Declared here rather than left as a folder convention so "swap the provider,
 * keep everything else" is a type a host can program against — and so the
 * resume rule below is stated once instead of per provider.
 */
export interface AgentStreamMapper {
  /** Decodes and maps one line. An unreadable line becomes an `error` event, never an exception. */
  push(line: string): readonly AgentEvent[]
}

export interface MapperOptions {
  /**
   * Where the sequence resumes from.
   *
   * A session reopened from a persisted log must continue its numbering, or
   * replayed events sort in front of stored ones and the transcript reorders
   * itself on reconnect. Event ids embed the sequence, so getting this wrong
   * also mints ids that collide with the persisted log — and since ids are
   * React keys, that failure is silent.
   */
  readonly startSeq?: number
}

/** Whether an event belongs to the main conversation rather than a delegated run. */
export function isMainThread(event: AgentEvent): boolean {
  return event.agentPath.length === 0
}

/** A stable string key for a path, for use in maps and React keys. */
export function pathKey(path: AgentPath): string {
  return path.join(">")
}
