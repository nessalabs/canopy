/** @responsibility Turns Claude Code `stream-json` lines into normalized agent events, holding the little state that requires. */

import { pathKey } from "../../events"
import type {
  AgentEvent,
  AgentEventPayload,
  AgentPath,
  BlockRef,
  PlanStep,
  SessionInfo,
  AgentStreamMapper,
  MapperOptions,
  ToolResult,
  Usage,
  WorkflowAgentProgress,
  WorkflowPhaseProgress,
} from "../../events"
import { claudePlanStatus, claudeTaskKind } from "./mapping"
import { asArray, asNumber, asObject, asOneOf, asRecord, asString, asStrings } from "../../json"
import { toolKind, toolTitle } from "../tools"
import type {
  JsonValue,
  WireLine,
  WireContentBlock,
  WireEvent,
  WireStreamFrame,
  WireUsage,
} from "./wire"
import {
  ClaudeContentBlockType,
  ClaudeContentDeltaType,
  ClaudeStreamFrameType,
  ClaudeSystemSubtype,
  ClaudeWireType,
  parseWireLine,
} from "./wire"

/** Claude Code wraps a failed tool's message in this framing. It is wire syntax, not content — `isError` already carries the fact. */
const ERROR_OPEN = "<tool_use_error>"
const ERROR_CLOSE = "</tool_use_error>"

/**
 * How the CLI narrates an interruption inside an ordinary `user` line.
 *
 * Prose matching, which is safe here only because the truth arrives separately
 * on `result.terminal_reason`: a reworded notice costs one stray transcript row,
 * never a missed turn end.
 */
const INTERRUPT_PREFIX = "[Request interrupted by user"

/**
 * How many recent line uuids are remembered for replay detection.
 *
 * A replay is always adjacent — a reconnect re-sends its last chunk — so a
 * bounded window catches it without growing with the session.
 */
const UUID_MEMORY = 2048

function stripToolUseError(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith(ERROR_OPEN) || !trimmed.endsWith(ERROR_CLOSE)) return text
  return trimmed.slice(ERROR_OPEN.length, trimmed.length - ERROR_CLOSE.length).trim()
}

function normalizeUsage(usage: JsonValue | undefined, costUsd: number | null): Usage | null {
  // Absent usage is absent, not zero: `asRecord` would flatten a missing block
  // to `{}` and every counter to a confident zero, which is a claim the line
  // never made. `asObject` keeps the two answers apart.
  const fields = asObject(usage)
  if (fields === null) return null
  const input = asNumber(fields.input_tokens)
  const output = asNumber(fields.output_tokens)
  const cacheRead = asNumber(fields.cache_read_input_tokens)
  const cacheCreation = asNumber(fields.cache_creation_input_tokens)
  const counters = [input, output, cacheRead, cacheCreation].filter((count): count is number => count !== null)
  return {
    // Summed rather than sent: Anthropic reports the parts, so the total is
    // derived — but only from the parts that were actually reported, and only
    // from the ones that were really numbers.
    totalTokens: counters.length === 0 ? null : counters.reduce((sum, count) => sum + count, 0),
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    // Claude folds reasoning into its output count and reports no separate
    // figure, so this is unreported rather than zero.
    reasoningTokens: null,
    ...(costUsd === null ? {} : { totalCostUsd: costUsd }),
  }
}

/** Flattens either tool-result shape to text, and collects any images as `data:` URLs. */
function readToolResult(block: Record<string, JsonValue>, sidecar: JsonValue | undefined): ToolResult {
  const content = block.content
  const images: string[] = []
  let text = ""

  const flat = asString(content)
  if (flat !== null) {
    text = flat
  } else if (Array.isArray(content)) {
    const parts: string[] = []
    for (const entry of content) {
      const item = asRecord(entry)
      const itemText = asString(item.text)
      if (item.type === ClaudeContentBlockType.Text && itemText !== null) parts.push(itemText)
      if (item.type === ClaudeContentBlockType.Image) {
        const source = asRecord(item.source)
        const data = asString(source.data)
        if (data !== null && data.length > 0) {
          images.push(`data:${asString(source.media_type) ?? "image/png"};base64,${data}`)
        }
      }
    }
    text = parts.join("\n")
  }

  return {
    text: stripToolUseError(text),
    isError: block.is_error === true,
    structured: sidecar ?? null,
    images,
  }
}

/** Pulls the step id out of `TaskCreate`'s result text, which is the only place it appears. */
const CREATED_ID = /Task #(\d+)/

/** Reads `TodoWrite`'s argument into plan steps, tolerating a shape that has moved before. */
function readPlan(input: JsonValue): readonly PlanStep[] | null {
  const todos = asRecord(input).todos
  if (!Array.isArray(todos)) return null
  const steps: PlanStep[] = []
  for (const entry of todos) {
    const todo = asRecord(entry)
    const content = asString(todo.content)
    if (content === null) continue
    steps.push({
      id: null,
      content,
      status: claudePlanStatus(asString(todo.status)),
      ...(asString(todo.activeForm) !== null ? { activeForm: asString(todo.activeForm)! } : {}),
    })
  }
  return steps
}

/**
 * Maps one session's stdout into normalized events.
 *
 * Stateful by necessity, and the state is small and named: which message is
 * open (stream frames address blocks by index within it), how many blocks each
 * message has committed (Claude Code sends no index on committed lines), which
 * call spawned which agent (so nesting is a path rather than a flat id), and
 * what the last `init` said (so a model change is detectable at all).
 *
 * One instance per session. Feeding two sessions through one mapper interleaves
 * their block indices and produces silently wrong joins.
 */
export class ClaudeStreamMapper implements AgentStreamMapper {
  private seq: number
  /**
   * The open message per thread.
   *
   * Keyed by agent path, not global: a subagent's frames interleave with the
   * main thread's on one stdout, and a single slot means the last
   * `message_start` wins — so main-thread deltas would join a subagent's
   * message and the preview would never reconcile with its committed block.
   */
  private readonly openMessage = new Map<string, string>()
  /** Committed block count per thread and message id — the source of the derived index. */
  private readonly committedBlocks = new Map<string, number>()
  /**
   * Line uuids already absorbed, newest last.
   *
   * A replayed committed line would otherwise be counted a second time and
   * shift every later block index in that message by one, breaking the
   * delta join silently. Bounded, because a session's uuids are unbounded and
   * a replay is always near.
   */
  private readonly seenUuids = new Set<string>()
  /** The agent path a tool call's own events belong to, keyed by call id. */
  private readonly pathByCall = new Map<string, AgentPath>()
  /**
   * The plan as built so far.
   *
   * Held here rather than derived downstream because the incremental plan tools
   * put a step's id in the tool *result*, so the fold would have to correlate a
   * call, its arguments and its result to draw a checklist — which is exactly
   * the work this layer exists to do once.
   */
  private planSteps: PlanStep[] = []
  /** `TaskCreate` calls whose id has not come back yet, keyed by call id. */
  private readonly pendingPlanSteps = new Map<string, PlanStep>()
  private lastSession: SessionInfo | null = null
  /** How many `init` lines have been seen, which is what `SessionInfo.initIndex` reports. */
  private initCount = 0

  constructor(options: MapperOptions = {}) {
    this.seq = options.startSeq ?? 0
  }

  /** Decodes and maps one line. An undecodable line becomes a single `error` event rather than nothing. */
  push(line: string): readonly AgentEvent[] {
    const parsed = parseWireLine(line)
    if (!parsed.ok) {
      return [
        // The path is genuinely unrecoverable from an unparsed line, but the
        // session is not: it is whichever session this mapper is reading.
        this.build(
          { type: "error", message: `unreadable line: ${parsed.reason}` },
          this.lastSession?.sessionId ?? "unknown",
          [],
          null,
          { line: parsed.line },
        ),
      ]
    }
    return this.map(parsed.line)
  }

  /** Maps an already-decoded line. */
  map(event: WireLine): readonly AgentEvent[] {
    const raw = event as JsonValue
    const line = asRecord(raw)
    // A line delivered twice — a replayed tail, two captures concatenated —
    // must be absorbed once: counting a committed block a second time shifts
    // every later index in that message and breaks the delta join silently.
    const uuid = asString(asRecord(raw).uuid)
    if (uuid !== null) {
      if (this.seenUuids.has(uuid)) return []
      this.seenUuids.add(uuid)
      if (this.seenUuids.size > UUID_MEMORY) {
        const oldest = this.seenUuids.values().next()
        if (!oldest.done) this.seenUuids.delete(oldest.value)
      }
    }
    const sessionId = asString(line.session_id) ?? this.lastSession?.sessionId ?? "unknown"
    const path = this.pathOf(line.parent_tool_use_id)
    const ts = asString(line.timestamp)

    switch (event.type) {
      case ClaudeWireType.System:
        return this.mapSystem(asString(asRecord(raw).subtype) ?? "unknown", sessionId, path, ts, raw)
      case ClaudeWireType.StreamEvent:
        // Read, not asserted: `mapStreamFrame` narrows every field it uses.
        return this.wrap(this.mapStreamFrame(asRecord(line.event) as WireStreamFrame, path), sessionId, path, ts, raw)
      case ClaudeWireType.Assistant:
        return this.mapAssistant(asRecord(raw), sessionId, path, ts, raw)
      case ClaudeWireType.User:
        return this.mapUser(asRecord(raw), sessionId, path, ts, raw)
      case ClaudeWireType.Result:
        return this.mapResult(asRecord(raw), sessionId, path, ts, raw)
      case ClaudeWireType.RateLimit: {
        const info = asRecord(asRecord(raw).rate_limit_info)
        const status = asString(info.status) ?? "unknown"
        // The steady state is reported constantly and is not worth a row; only
        // a limit that has been reached or is being billed as overage is.
        if (status === "allowed" && info.isUsingOverage !== true) return []
        const resetsAt = asNumber(info.resetsAt)
        return this.wrap(
          {
            type: "rate_limited",
            status,
            resetsAt: resetsAt === null ? null : new Date(resetsAt * 1000).toISOString(),
            window: asString(info.rateLimitType),
            usingOverage: info.isUsingOverage === true,
          },
          sessionId,
          path,
          ts,
          raw,
        )
      }
      case ClaudeWireType.ControlRequest: {
        const request = asRecord(asRecord(raw).request)
        if (asString(request.subtype) !== "can_use_tool") {
          return this.wrap({ type: "unknown", wireType: "control_request", subtype: asString(request.subtype) }, sessionId, path, ts, raw)
        }
        return this.wrap(
          {
            type: "permission_requested",
            requestId: asString(asRecord(raw).request_id) ?? "",
            callId: asString(request.tool_use_id) ?? "",
            toolName: asString(request.tool_name) ?? "",
            input: request.input ?? null,
            // The wire names this `decision_reason_type` ("rule", "mode", ...).
            // `decision_reason` is accepted too because older builds sent it,
            // and a null reason would quietly turn a rule-driven ask into an
            // unexplained one.
            reason: asString(request.decision_reason_type) ?? asString(request.decision_reason),
            displayName: asString(request.display_name),
            description: asString(request.description),
          },
          sessionId,
          path,
          ts,
          raw,
        )
      }
      case ClaudeWireType.ControlResponse: {
        const envelope = asRecord(asRecord(raw).response)
        const answer = asRecord(envelope.response)
        return this.wrap(
          {
            type: "permission_decided",
            requestId: asString(envelope.request_id) ?? "",
            decision: asOneOf(answer.behavior, ["allow", "deny"] as const),
            message: asString(answer.message),
          },
          sessionId,
          path,
          ts,
          raw,
        )
      }
      default:
        return this.wrap({ type: "unknown", wireType: event.type, subtype: asString(asRecord(raw).subtype) }, sessionId, path, ts, raw)
    }
  }

  private mapSystem(
    subtype: string,
    sessionId: string,
    path: AgentPath,
    ts: string | null,
    raw: JsonValue,
  ): readonly AgentEvent[] {
    const line = asRecord(raw)
    switch (subtype) {
      case ClaudeSystemSubtype.Init: {
        const session: SessionInfo = {
          sessionId,
          model: asString(line.model),
          cwd: asString(line.cwd),
          tools: asStrings(line.tools),
          slashCommands: asStrings(line.slash_commands),
          agents: asStrings(line.agents),
          skills: asStrings(line.skills),
          mcpServers: Array.isArray(line.mcp_servers)
            ? line.mcp_servers.map((entry) => ({
                name: asString(asRecord(entry).name) ?? "",
                status: asString(asRecord(entry).status) ?? "unknown",
              }))
            : [],
          terminalSlashCommands: asStrings(line.terminal_slash_commands),
          plugins: Array.isArray(line.plugins)
            ? line.plugins.map((entry) => ({
                name: asString(asRecord(entry).name) ?? "",
                version: asString(asRecord(entry).version),
                source: asString(asRecord(entry).source) ?? "",
              }))
            : [],
          permissionMode: asString(line.permissionMode),
          version: asString(line.claude_code_version),
          outputStyle: asString(line.output_style),
          initIndex: this.initCount,
        }
        const previous = this.lastSession
        this.lastSession = session
        this.initCount += 1

        const events = [this.build({ type: "session_started", session }, sessionId, path, ts, raw)]
        // A resumed run with `--model` looks exactly like this and nothing else
        // announces it, so the change is derived from two inits or not seen.
        // A change is only a change when both sides said something.
        if (
          previous !== null &&
          previous.sessionId === sessionId &&
          previous.model !== null &&
          session.model !== null &&
          previous.model !== session.model
        ) {
          events.push(this.build({ type: "model_changed", from: previous.model, to: session.model }, sessionId, path, ts, raw))
        }
        return events
      }

      case ClaudeSystemSubtype.Status:
        return this.wrap(
          { type: "status_changed", status: asString(line.status), permissionMode: asString(line.permissionMode) },
          sessionId,
          path,
          ts,
          raw,
        )

      case ClaudeSystemSubtype.TaskSummary: {
        const detail = asString(line.detail)
        return detail === null ? [] : this.wrap({ type: "activity", detail }, sessionId, path, ts, raw)
      }

      case ClaudeSystemSubtype.TaskStarted: {
        const callId = asString(line.tool_use_id) ?? ""
        return this.wrap(
          {
            type: "task_started",
            taskId: asString(line.task_id) ?? "",
            callId,
            taskKind: claudeTaskKind(asString(line.task_type)),
            label: asString(line.subagent_type) ?? asString(line.workflow_name),
            description: asString(line.description) ?? "",
            prompt: asString(line.prompt),
            // Claude names no transcript for a delegated run. A subagent's
            // sits on disk under a path derived from the session, which
            // `claude/store` works out; a workflow agent's is watchable only.
            transcriptId: null,
          },
          sessionId,
          path,
          ts,
          raw,
        )
      }

      case ClaudeSystemSubtype.TaskProgress: {
        const progress = this.build(
          {
            type: "task_progress",
            taskId: asString(line.task_id) ?? "",
            callId: asString(line.tool_use_id) ?? "",
            description: asString(line.description) ?? "",
            lastTool: asString(line.last_tool_name),
            usage: taskUsage(asRecord(line.usage)),
          },
          sessionId,
          path,
          ts,
          raw,
        )
        // The board rides along on only *some* progress lines, so a consumer
        // keeps the last one it saw rather than expecting one per update.
        const phases = readWorkflowProgress(line.workflow_progress)
        if (phases === null) return [progress]
        return [
          progress,
          this.build(
            {
              type: "workflow_progress",
              taskId: asString(line.task_id) ?? "",
              callId: asString(line.tool_use_id) ?? "",
              phases,
            },
            sessionId,
            path,
            ts,
            raw,
          ),
        ]
      }

      case ClaudeSystemSubtype.TaskNotification:
        return this.wrap(
          {
            type: "task_completed",
            taskId: asString(line.task_id) ?? "",
            callId: asString(line.tool_use_id),
            status: asString(line.status) ?? "completed",
            summary: asString(line.summary),
            usage: taskUsage(asRecord(line.usage)),
          },
          sessionId,
          path,
          ts,
          raw,
        )

      // `task_updated` carries only a status patch the notification repeats, so
      // it earns no row of its own — but it is the only completion signal a
      // task that never notifies will send, so it is mapped, not dropped.
      case ClaudeSystemSubtype.TaskUpdated: {
        const patch = asRecord(line.patch)
        const status = asString(patch.status)
        return status === null
          ? []
          : this.wrap(
              { type: "task_completed", taskId: asString(line.task_id) ?? "", callId: null, status, summary: null, usage: null },
              sessionId,
              path,
              ts,
              raw,
            )
      }

      case ClaudeSystemSubtype.BackgroundTasksChanged:
        return this.wrap(
          {
            type: "background_tasks_changed",
            tasks: Array.isArray(line.tasks)
              ? line.tasks.map((entry) => ({
                  taskId: asString(asRecord(entry).task_id) ?? "",
                  description: asString(asRecord(entry).description) ?? "",
                }))
              : [],
          },
          sessionId,
          path,
          ts,
          raw,
        )

      case ClaudeSystemSubtype.ThinkingTokens: {
        const tokens = asNumber(line.estimated_tokens)
        return tokens === null ? [] : this.wrap({ type: "thinking_progress", tokens }, sessionId, path, ts, raw)
      }

      case ClaudeSystemSubtype.HookStarted:
      case ClaudeSystemSubtype.HookResponse:
        return this.wrap(
          {
            type: "hook",
            phase: subtype === ClaudeSystemSubtype.HookStarted ? "started" : "finished",
            name: asString(line.hook_name) ?? "",
            event: asString(line.hook_event) ?? "",
            outcome: asString(line.outcome),
            exitCode: asNumber(line.exit_code),
          },
          sessionId,
          path,
          ts,
          raw,
        )

      case ClaudeSystemSubtype.PostTurnSummary:
        return this.wrap(
          {
            type: "post_turn_summary",
            category: asString(line.status_category) ?? "",
            detail: asString(line.status_detail) ?? "",
            needsAction: asString(line.needs_action) === "" ? null : asString(line.needs_action),
          },
          sessionId,
          path,
          ts,
          raw,
        )

      case ClaudeSystemSubtype.CompactBoundary: {
        const meta = asRecord(line.compact_metadata)
        return this.wrap(
          {
            type: "context_compacted",
            trigger: asString(meta.trigger),
            preTokens: asNumber(meta.pre_tokens),
            postTokens: asNumber(meta.post_tokens),
            droppedTokens: asNumber(meta.cumulative_dropped_tokens),
            durationMs: asNumber(meta.duration_ms),
          },
          sessionId,
          path,
          ts,
          raw,
        )
      }

      case ClaudeSystemSubtype.PermissionDenied:
        return this.wrap(
          {
            type: "permission_denied",
            callId: asString(line.tool_use_id) ?? "",
            toolName: asString(line.tool_name) ?? "",
            message: asString(line.message) ?? "",
          },
          sessionId,
          path,
          ts,
          raw,
        )

      default:
        return this.wrap({ type: "unknown", wireType: "system", subtype }, sessionId, path, ts, raw)
    }
  }

  /**
   * Maps one SSE frame.
   *
   * Everything here is *read* rather than asserted. The wire types describe the
   * shapes a well-formed frame has; a truncated or reordered line is not
   * well-formed, and a cast would turn that into a crash inside the mapper —
   * ending the transcript over one bad line, which is exactly what this parser
   * exists to avoid.
   */
  private mapStreamFrame(frame: WireStreamFrame, path: AgentPath): AgentEventPayload | null {
    const fields = asRecord(frame as unknown as JsonValue)
    const thread = pathKey(path)

    switch (frame.type) {
      case ClaudeStreamFrameType.MessageStart: {
        const id = asString(asRecord(fields.message).id)
        // No id means no join key for the blocks that follow, so the preview is
        // skipped entirely rather than attached to whatever message was open.
        if (id === null) return null
        // A message's block count is dead the moment the next one opens on the
        // same thread — the CLI never revisits a committed message — so it is
        // dropped here rather than accreting an entry per message for the life
        // of the session.
        const previous = this.openMessage.get(thread)
        if (previous !== undefined && previous !== id) this.committedBlocks.delete(`${thread}\u0000${previous}`)
        this.openMessage.set(thread, id)
        return null
      }

      case ClaudeStreamFrameType.ContentBlockStart: {
        const block = this.blockRef(thread, asNumber(fields.index))
        if (block === null) return null
        const content = asRecord(fields.content_block)
        const contentType = asString(content.type)
        if (contentType === ClaudeContentBlockType.Text) {
          return { type: "delta", delta: "block_start", block, blockType: "text" }
        }
        if (contentType === ClaudeContentBlockType.Thinking) {
          return { type: "delta", delta: "block_start", block, blockType: "thinking" }
        }
        if (contentType === ClaudeContentBlockType.ToolUse) {
          const toolId = asString(content.id)
          const toolName = asString(content.name)
          // A tool block without both is not a labelable call, and the payload
          // promises both together — so it degrades to an unlabelled block
          // rather than a half-built one.
          if (toolId === null || toolName === null) {
            return { type: "delta", delta: "block_start", block, blockType: "text" }
          }
          return { type: "delta", delta: "block_start", block, blockType: "tool_use", toolId, toolName }
        }
        // An unknown block kind is skipped rather than guessed: the committed
        // line still carries the content, so nothing is lost but the preview.
        return null
      }

      case ClaudeStreamFrameType.ContentBlockDelta: {
        const block = this.blockRef(thread, asNumber(fields.index))
        if (block === null) return null
        const delta = asRecord(fields.delta)
        const deltaType = asString(delta.type)

        if (deltaType === ClaudeContentDeltaType.Text) {
          const text = asString(delta.text)
          return text === null ? null : { type: "delta", delta: "text", block, text }
        }
        // Thinking text rides the same shape; `block_start` already said which
        // kind the block is, so a second variant would only repeat it.
        if (deltaType === ClaudeContentDeltaType.Thinking) {
          const text = asString(delta.thinking)
          return text === null ? null : { type: "delta", delta: "text", block, text }
        }
        if (deltaType === ClaudeContentDeltaType.InputJson) {
          const partialJson = asString(delta.partial_json)
          return partialJson === null ? null : { type: "delta", delta: "input", block, partialJson }
        }
        // `signature_delta` signs the thinking block; it is not display content.
        return null
      }

      case ClaudeStreamFrameType.ContentBlockStop: {
        const block = this.blockRef(thread, asNumber(fields.index))
        return block === null ? null : { type: "delta", delta: "block_stop", block }
      }

      // The committed `assistant` and `result` lines carry these facts already.
      default:
        return null
    }
  }

  private mapAssistant(
    line: Record<string, JsonValue>,
    sessionId: string,
    path: AgentPath,
    ts: string | null,
    raw: JsonValue,
  ): readonly AgentEvent[] {
    const message = asRecord(line.message)
    const messageId = asString(message.id) ?? "unknown"
    const blocks = Array.isArray(message.content) ? message.content : []
    const events: AgentEvent[] = []

    for (const entry of blocks) {
      const block = asRecord(entry)
      // Committed lines carry no index; it is derived by counting blocks per
      // message id in arrival order, which is what joins them to their deltas.
      const ref = this.nextBlockRef(pathKey(path), messageId)
      const type = asString(block.type)

      if (type === ClaudeContentBlockType.Text) {
        events.push(this.build({ type: "assistant_text", text: asString(block.text) ?? "", block: ref }, sessionId, path, ts, raw))
        continue
      }
      if (type === ClaudeContentBlockType.Thinking) {
        events.push(this.build({ type: "reasoning", text: asString(block.thinking) ?? "", block: ref }, sessionId, path, ts, raw))
        continue
      }
      if (type === ClaudeContentBlockType.ToolUse) {
        const callId = asString(block.id) ?? ""
        const name = asString(block.name) ?? ""
        const input = block.input ?? {}
        // A call made *here* is the parent of anything that call spawns, so the
        // path for its children is this path plus the call itself. This is what
        // makes a subagent inside a subagent nest instead of flattening.
        this.pathByCall.set(callId, [...path, callId])
        events.push(
          this.build(
            { type: "tool_call_started", callId, name, kind: toolKind(name), input, title: toolTitle(name, input) },
            sessionId,
            path,
            ts,
            raw,
          ),
        )
        // The plan is an argument to a tool call, not an event of its own, so
        // it is lifted here — a consumer should never have to reach into tool
        // input to draw the agent's plan.
        const planEvent = this.mapPlanCall(callId, name, input, sessionId, path, ts, raw)
        if (planEvent !== null) events.push(planEvent)
      }
    }

    return events
  }

  private mapUser(
    line: Record<string, JsonValue>,
    sessionId: string,
    path: AgentPath,
    ts: string | null,
    raw: JsonValue,
  ): readonly AgentEvent[] {
    const message = asRecord(line.message)
    const content = message.content
    const synthetic = line.isSynthetic === true || line.isReplay === true

    // A `user` line's content is one of two unrelated shapes with nothing
    // labelling which: a bare string is the human's prompt, an array is what
    // the CLI fed back. The shape is the discriminator.
    const typed = asString(content)
    if (typed !== null) {
      return this.wrap({ type: "user_message", text: typed, synthetic }, sessionId, path, ts, raw)
    }
    if (!Array.isArray(content)) return []

    const events: AgentEvent[] = []
    for (const entry of content) {
      const block = asRecord(entry)
      const type = asString(block.type)
      if (type === ClaudeContentBlockType.ToolResult) {
        const callId = asString(block.tool_use_id) ?? ""
        const result = readToolResult(block, line.tool_use_result)
        events.push(this.build({ type: "tool_call_completed", callId, result }, sessionId, path, ts, raw))
        const settled = this.settlePlanStep(callId, result.text)
        if (settled !== null) events.push(this.build(settled, sessionId, path, ts, raw))
        continue
      }
      if (type === ClaudeContentBlockType.Text) {
        const text = asString(block.text) ?? ""
        if (text.startsWith(INTERRUPT_PREFIX)) {
          events.push(this.build({ type: "error", message: text }, sessionId, path, ts, raw))
          continue
        }
        // Marked synthetic whatever the flags say. A human prompt arrives as
        // the bare-string shape; a text block inside the array shape is the CLI
        // feeding the model — a delegated run's brief, an injected reminder —
        // and treating it as a prompt opens a phantom turn whose header is text
        // the reader never wrote.
        events.push(this.build({ type: "user_message", text, synthetic: true }, sessionId, path, ts, raw))
      }
    }
    return events
  }

  private mapResult(
    line: Record<string, JsonValue>,
    sessionId: string,
    path: AgentPath,
    ts: string | null,
    raw: JsonValue,
  ): readonly AgentEvent[] {
    const terminalReason = asString(line.terminal_reason)
    const isError = line.is_error === true
    const status = isError ? "error" : terminalReason === "interrupted" ? "interrupted" : "completed"
    return this.wrap(
      {
        type: "turn_completed",
        status,
        stopReason: asString(line.stop_reason),
        terminalReason,
        finalText: asString(line.result),
        usage: normalizeUsage(line.usage, asNumber(line.total_cost_usd)),
        durationMs: asNumber(line.duration_ms),
        numTurns: asNumber(line.num_turns),
        permissionDenials: asArray(line.permission_denials).map((entry) => {
          const denial = asRecord(entry)
          return {
            toolName: asString(denial.tool_name) ?? "",
            callId: asString(denial.tool_use_id) ?? "",
            input: denial.tool_input ?? null,
          }
        }),
      },
      sessionId,
      path,
      ts,
      raw,
    )
  }

  /**
   * Folds a plan-tool call into the running plan.
   *
   * `TodoWrite` republishes everything, so it simply replaces. `TaskCreate`
   * cannot publish yet — the step has no id until its result comes back — so it
   * is parked and settled in `settlePlanStep`. `TaskUpdate` patches in place.
   */
  private mapPlanCall(
    callId: string,
    name: string,
    input: JsonValue,
    sessionId: string,
    path: AgentPath,
    ts: string | null,
    raw: JsonValue,
  ): AgentEvent | null {
    if (name === "TodoWrite") {
      const steps = readPlan(input)
      if (steps === null) return null
      this.planSteps = [...steps]
      return this.build({ type: "plan_updated", steps: this.planSteps }, sessionId, path, ts, raw)
    }

    const argument = asRecord(input)
    if (name === "TaskCreate") {
      const content = asString(argument.subject) ?? asString(argument.description)
      if (content === null) return null
      this.pendingPlanSteps.set(callId, {
        id: null,
        content,
        status: "pending",
        ...(asString(argument.activeForm) !== null ? { activeForm: asString(argument.activeForm)! } : {}),
      })
      return null
    }

    if (name === "TaskUpdate") {
      const id = asString(argument.taskId) ?? (asNumber(argument.taskId) === null ? null : String(asNumber(argument.taskId)))
      if (id === null) return null
      // An update that names no status is a rename, so the step keeps the one
      // it has rather than being reset to pending.
      const status = argument.status === undefined ? null : claudePlanStatus(asString(argument.status))
      this.planSteps = this.planSteps.map((step) =>
        step.id !== id
          ? step
          : { ...step, content: asString(argument.subject) ?? step.content, status: status ?? step.status },
      )
      return this.build({ type: "plan_updated", steps: this.planSteps }, sessionId, path, ts, raw)
    }

    return null
  }

  /** Attaches the id a `TaskCreate` result carries, which is what makes the step patchable. */
  private settlePlanStep(callId: string, resultText: string): AgentEventPayload | null {
    const pending = this.pendingPlanSteps.get(callId)
    if (pending === undefined) return null
    this.pendingPlanSteps.delete(callId)
    const match = CREATED_ID.exec(resultText)
    // Falling back to position keeps the step visible when the wording moves.
    // The sentinel prefix keeps it out of the wire's own id space, so a later
    // TaskUpdate for the real step "3" cannot also patch a guessed "3".
    const id = match === null ? `local:${this.planSteps.length + 1}` : match[1]!
    this.planSteps = [...this.planSteps, { ...pending, id }]
    return { type: "plan_updated", steps: this.planSteps }
  }

  /**
   * The path an event with this `parent_tool_use_id` belongs to.
   *
   * Resolved through the call that spawned it, so depth accumulates: a call
   * made inside a subagent already has that subagent's path recorded, and the
   * fallback covers a capture that starts mid-run with the spawning call
   * already off the top of the log.
   */
  private pathOf(parentToolUseId: JsonValue | undefined): AgentPath {
    const id = asString(parentToolUseId)
    if (id === null) return []
    return this.pathByCall.get(id) ?? [id]
  }

  private nextBlockRef(thread: string, messageId: string): BlockRef {
    const key = `${thread}\u0000${messageId}`
    const index = this.committedBlocks.get(key) ?? 0
    this.committedBlocks.set(key, index + 1)
    return { messageId, index }
  }

  /**
   * Null rather than a placeholder: `BlockRef` is a join key, and a wrong one
   * attaches streamed text to the wrong block — silently. A frame with no
   * readable index has no join key at all, so it produces no preview.
   */
  private blockRef(thread: string, index: number | null): BlockRef | null {
    const messageId = this.openMessage.get(thread)
    if (messageId === undefined || index === null) return null
    return { messageId, index }
  }

  private wrap(
    payload: AgentEventPayload | null,
    sessionId: string,
    path: AgentPath,
    ts: string | null,
    raw: JsonValue,
  ): readonly AgentEvent[] {
    return payload === null ? [] : [this.build(payload, sessionId, path, ts, raw)]
  }

  private build(
    payload: AgentEventPayload,
    sessionId: string,
    path: AgentPath,
    ts: string | null,
    raw: JsonValue,
  ): AgentEvent {
    const seq = this.seq
    this.seq += 1
    return { id: `${sessionId}:${seq}`, sessionId, seq, ts, agentPath: path, payload, raw }
  }
}

/**
 * Reads a workflow's progress board.
 *
 * The wire sends one flat array mixing `workflow_phase` and `workflow_agent`
 * entries, each agent naming its phase by index; this rebuilds the nesting the
 * flat list implies. Phases with no agents yet are kept — a phase that has been
 * declared but not reached is part of the picture.
 */
function readWorkflowProgress(value: JsonValue | undefined): readonly WorkflowPhaseProgress[] | null {
  if (!Array.isArray(value)) return null

  const phases = new Map<number, { index: number; title: string; agents: WorkflowAgentProgress[] }>()
  const orphans: WorkflowAgentProgress[] = []
  /** How many agents have been read, so an unindexed one still has an identity. */
  let seen = 0

  for (const item of value) {
    const entry = asRecord(item)
    if (asString(entry.type) === "workflow_phase") {
      const index = asNumber(entry.index) ?? 0
      const existing = phases.get(index)
      if (existing === undefined) {
        phases.set(index, { index, title: asString(entry.title) ?? `Phase ${index}`, agents: [] })
      }
      continue
    }
    if (asString(entry.type) !== "workflow_agent") continue

    const agent: WorkflowAgentProgress = {
      // Position in the board when the wire gives no index of its own: a
      // queued agent has none, and defaulting every one of them to zero made
      // several agents share an identity, so a view keyed on it drew one.
      index: asNumber(entry.index) ?? seen++,
      label: asString(entry.label) ?? "agent",
      phaseIndex: asNumber(entry.phaseIndex) ?? 0,
      phaseTitle: asString(entry.phaseTitle) ?? "",
      agentId: asString(entry.agentId),
      model: asString(entry.model),
      state: asString(entry.state) ?? "unknown",
      queuedAt: asNumber(entry.queuedAt),
      startedAt: asNumber(entry.startedAt),
      attempt: asNumber(entry.attempt),
      promptPreview: asString(entry.promptPreview),
      resultPreview: asString(entry.resultPreview),
      tokens: asNumber(entry.tokens),
      toolCalls: asNumber(entry.toolCalls),
      durationMs: asNumber(entry.durationMs),
    }
    const phase = phases.get(agent.phaseIndex)
    if (phase === undefined) orphans.push(agent)
    else phase.agents.push(agent)
  }

  // An agent whose phase never appeared still belongs on screen; it gets a
  // phase built from the title it names.
  for (const agent of orphans) {
    const phase = phases.get(agent.phaseIndex)
    if (phase === undefined) {
      phases.set(agent.phaseIndex, {
        index: agent.phaseIndex,
        title: agent.phaseTitle === "" ? `Phase ${agent.phaseIndex}` : agent.phaseTitle,
        agents: [agent],
      })
    } else phase.agents.push(agent)
  }

  if (phases.size === 0) return null
  return [...phases.values()]
    .sort((a, b) => a.index - b.index)
    .map((phase) => ({ ...phase, agents: [...phase.agents].sort((a, b) => a.index - b.index) }))
}

/**
 * A delegated run's usage, which is a total and nothing else.
 *
 * The breakdown stays null rather than zero: the wire reports one figure here,
 * and zeros would read as "no input tokens" — a claim the line never made.
 */
function taskUsage(usage: Record<string, JsonValue>): Usage | null {
  const total = asNumber(usage.total_tokens)
  if (total === null) return null
  return {
    totalTokens: total,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    reasoningTokens: null,
  }
}

/** Maps a whole capture in one pass, for a persisted log or a fixture. */
export function mapClaudeStream(text: string, options?: MapperOptions): readonly AgentEvent[] {
  const mapper = new ClaudeStreamMapper(options)
  const events: AgentEvent[] = []
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue
    events.push(...mapper.push(line))
  }
  return events
}
