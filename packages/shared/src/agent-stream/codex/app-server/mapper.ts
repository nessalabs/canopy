/** @responsibility Turns `codex app-server` JSON-RPC frames into normalized agent events. */

import { EventSink } from "../../emitter"
import type { AgentEvent, AgentStreamMapper, MapperOptions, PlanStep, SessionInfo } from "../../events"
import { PlanStepStatus } from "../../events"
import { asArray, asNumber, asRecord, asString } from "../../json"
import type { JsonValue } from "../../json"
import { CodexAppServerItemType, CodexAppServerNotification, CodexAppServerRequest, parseCodexAppServerLine } from "./wire"
import type { CodexAppServerFrame } from "./wire"

/**
 * Reads the app-server conversation.
 *
 * The same agent as `exec --json` behind a different protocol, and the
 * differences are the point: it carries the prompt, streams the answer, takes
 * steering mid-turn, and lets a client ask for compaction. A client's own
 * frames are mapped too, since they are the only record of what was asked.
 */
export class CodexAppServerMapper implements AgentStreamMapper {
  private readonly emit: EventSink
  /** Item kinds by id, so a completion that omits the kind keeps the one it opened with. */
  private readonly items = new Map<string, string>()
  /** Threads described by a reply, for when the notification arrives first. */
  private readonly described = new Map<string, Record<string, JsonValue>>()

  constructor(options: MapperOptions = {}) {
    this.emit = new EventSink(options.startSeq ?? 0)
  }

  push(line: string): readonly AgentEvent[] {
    const parsed = parseCodexAppServerLine(line)
    if (parsed === null) return []
    if (!parsed.ok) {
      return [this.emit.build({ type: "error", message: `unreadable frame: ${parsed.reason}` }, { line: parsed.line }, null)]
    }
    return this.map(parsed.line)
  }

  map(event: CodexAppServerFrame): readonly AgentEvent[] {
    const raw = event as JsonValue
    const frame = asRecord(raw)
    const method = asString(frame.method)
    // A response, which is where `thread/start` describes the thread it made.
    if (method === null) return this.response(asRecord(frame.result), raw)
    const params = asRecord(frame.params)

    const threadId = asString(params.threadId)
    if (threadId !== null) {
      this.emit.current = threadId
      this.emit.primary ??= threadId
    }

    switch (method) {
      case CodexAppServerRequest.TurnStart:
      case CodexAppServerRequest.TurnSteer: {
        const text = asArray(params.input)
          .map((entry) => asString(asRecord(entry).text))
          .filter((part): part is string => part !== null)
          .join("")
        if (text === "") return []
        return [this.emit.build({ type: "user_message", text, synthetic: false }, raw, null)]
      }

      case CodexAppServerNotification.ThreadStarted:
        return this.open(asRecord(params.thread), asString(params.threadId), raw)

      case CodexAppServerNotification.ThreadStatusChanged:
        return [
          this.emit.build(
            { type: "status_changed", status: asString(asRecord(params.status).type), permissionMode: null },
            raw,
            null,
          ),
        ]

      case CodexAppServerNotification.TurnCompleted: {
        const usage = asRecord(asRecord(params.turn).usage)
        return [
          this.emit.build(
            {
              type: "turn_completed",
              status: "completed",
              stopReason: asString(asRecord(params.turn).status),
              terminalReason: null,
              finalText: null,
              usage: {
                totalTokens: asNumber(usage.totalTokens),
                inputTokens: asNumber(usage.inputTokens),
                outputTokens: asNumber(usage.outputTokens),
                reasoningTokens: asNumber(usage.reasoningOutputTokens),
                cacheReadTokens: asNumber(usage.cachedInputTokens),
                cacheCreationTokens: null,
              },
              durationMs: asNumber(asRecord(params.turn).durationMs),
              numTurns: null,
              permissionDenials: [],
            },
            raw,
            null,
          ),
        ]
      }

      case CodexAppServerNotification.ItemAgentMessageDelta: {
        const delta = asString(params.delta)
        const itemId = asString(params.itemId)
        if (delta === null || itemId === null) return []
        // The token stream `exec --json` does not have. Blocks are keyed by the
        // item, which is what the completed message will be published under.
        return [
          this.emit.build(
            { type: "delta", delta: "text", block: { messageId: itemId, index: 0 }, text: delta },
            raw,
            null,
          ),
        ]
      }

      case CodexAppServerNotification.TurnPlanUpdated:
        return this.plan(asArray(params.plan ?? asRecord(params.turn).plan), raw)

      case CodexAppServerNotification.ItemStarted:
      case CodexAppServerNotification.ItemCompleted:
        return this.item(method, asRecord(params.item), raw)

      case CodexAppServerNotification.HookStarted:
      case CodexAppServerNotification.HookCompleted:
        return [
          this.emit.build(
            {
              type: "hook",
              phase: method === CodexAppServerNotification.HookStarted ? "started" : "finished",
              name: asString(params.name) ?? asString(asRecord(params.hook).name) ?? "hook",
              event: asString(params.event) ?? asString(asRecord(params.hook).event) ?? method,
              outcome: asString(asRecord(params.result).status),
              exitCode: asNumber(asRecord(params.result).exitCode),
            },
            raw,
            null,
          ),
        ]

      case CodexAppServerNotification.Error:
        return [this.emit.build({ type: "error", message: asString(params.message) ?? "error" }, raw, null)]

      default:
        return []
    }
  }

  /** One item, opening or settling. */
  private item(method: string, item: Record<string, JsonValue>, raw: JsonValue): readonly AgentEvent[] {
    const id = asString(item.id) ?? "unknown"
    const type = asString(item.type) ?? this.items.get(id) ?? null
    if (type !== null) this.items.set(id, type)
    const opening = method === CodexAppServerNotification.ItemStarted

    switch (type) {
      case CodexAppServerItemType.AgentMessage: {
        if (opening) return []
        const text = asString(item.text) ?? textOf(item)
        if (text === "") return []
        return [this.emit.build({ type: "assistant_text", text, block: { messageId: id, index: 0 } }, raw, null)]
      }
      case CodexAppServerItemType.Reasoning: {
        if (opening) return []
        return [this.emit.build({ type: "reasoning", text: asString(item.text) ?? textOf(item), block: null }, raw, null)]
      }
      case CodexAppServerItemType.CommandExecution: {
        if (opening) {
          return [
            this.emit.build(
              {
                type: "tool_call_started",
                callId: id,
                name: "command",
                kind: "shell",
                input: item.command ?? null,
                title: asString(item.command) ?? "command",
              },
              raw,
              null,
            ),
          ]
        }
        const exit = asNumber(item.exitCode)
        return [
          this.emit.build(
            {
              type: "tool_call_completed",
              callId: id,
              result: {
                text: asString(item.aggregatedOutput) ?? "",
                isError: exit !== null && exit !== 0,
                structured: item.exitCode ?? null,
                images: [],
              },
            },
            raw,
            null,
          ),
        ]
      }
      case CodexAppServerItemType.FileChange: {
        if (opening) {
          return [
            this.emit.build(
              { type: "tool_call_started", callId: id, name: "file change", kind: "file_edit", input: item.changes ?? null, title: "file change" },
              raw,
              null,
            ),
          ]
        }
        const edits = asArray(item.changes).flatMap((entry) => {
          const change = asRecord(entry)
          const path = asString(change.path)
          return path === null ? [] : [{ path, change: "update" as const, unifiedDiff: null }]
        })
        const events: AgentEvent[] = [
          this.emit.build(
            { type: "tool_call_completed", callId: id, result: { text: "", isError: false, structured: item.changes ?? null, images: [] } },
            raw,
            null,
          ),
        ]
        if (edits.length > 0) events.push(this.emit.build({ type: "file_edits", callId: id, edits }, raw, null))
        return events
      }
      case CodexAppServerItemType.McpToolCall:
      case CodexAppServerItemType.WebSearch: {
        const isSearch = type === CodexAppServerItemType.WebSearch
        const title = isSearch ? (asString(item.query) ?? "web search") : (asString(item.tool) ?? "mcp tool")
        if (opening) {
          return [
            this.emit.build(
              {
                type: "tool_call_started",
                callId: id,
                name: title,
                kind: isSearch ? "web" : "mcp",
                input: (isSearch ? item.query : item.arguments) ?? null,
                title,
              },
              raw,
              null,
            ),
          ]
        }
        return [
          this.emit.build(
            {
              type: "tool_call_completed",
              callId: id,
              result: {
                text: asString(item.result) ?? textOf(item),
                isError: asString(item.status) === "failed",
                structured: item.result ?? null,
                images: [],
              },
            },
            raw,
            null,
          ),
        ]
      }

      case CodexAppServerItemType.Todo:
        return opening ? [] : this.plan(asArray(item.items ?? item.todos), raw)
      case CodexAppServerItemType.Error:
        return opening ? [] : [this.emit.build({ type: "error", message: asString(item.message) ?? "error" }, raw, null)]
      default:
        return []
    }
  }

  private plan(entries: readonly JsonValue[], raw: JsonValue): readonly AgentEvent[] {
    const steps: PlanStep[] = []
    for (const entry of entries) {
      const step = asRecord(entry)
      const content = asString(step.step) ?? asString(step.content) ?? asString(step.text)
      if (content === null) continue
      const status = asString(step.status)
      steps.push({
        id: null,
        content,
        status:
          status === "completed" ? PlanStepStatus.Completed : status === "in_progress" ? PlanStepStatus.InProgress : PlanStepStatus.Pending,
      })
    }
    if (steps.length === 0) return []
    return [this.emit.build({ type: "plan_updated", steps }, raw, null)]
  }

  /**
   * A `thread/start` reply, which describes the thread the notification only
   * named. Reading responses is what lets the session say its model and its
   * working directory instead of reporting null for both.
   */
  private response(result: Record<string, JsonValue>, raw: JsonValue): readonly AgentEvent[] {
    const thread = asRecord(result.thread)
    const id = asString(thread.id)
    if (id === null) return []
    // The model sits *beside* the thread in this reply rather than inside it,
    // so the description is the two merged.
    const described = { ...thread, ...(result.model === undefined ? {} : { model: result.model }) }
    this.described.set(id, described)
    return this.open(described, id, raw)
  }

  private open(
    thread: Record<string, JsonValue>,
    threadId: string | null,
    raw: JsonValue,
  ): readonly AgentEvent[] {
    const described = threadId === null ? {} : (this.described.get(threadId) ?? {})
    const info = Object.keys(thread).length > 0 ? thread : described
    if (threadId === null || this.emit.openedSessions.has(threadId)) return []
    this.emit.openedSessions.add(threadId)
    this.emit.primary ??= threadId
    this.emit.current = threadId
    const session: SessionInfo = {
      sessionId: threadId,
      // The thread's own description, from whichever frame carried it: the
      // notification names it, and the `thread/start` reply describes it.
      model: asString(info.model),
      cwd: asString(info.cwd),
      tools: [],
      slashCommands: [],
      terminalSlashCommands: [],
      agents: [],
      skills: [],
      plugins: [],
      mcpServers: [],
      permissionMode: asString(info.approvalPolicy),
      version: asString(info.cliVersion),
      outputStyle: null,
      initIndex: this.emit.openedSessions.size - 1,
    }
    return [this.emit.build({ type: "session_started", session }, raw, null)]
  }
}

/** Content blocks flattened to text, for the items that carry them that way. */
function textOf(item: Record<string, JsonValue>): string {
  return asArray(item.content)
    .map((entry) => asString(asRecord(entry).text))
    .filter((part): part is string => part !== null)
    .join("")
}

/** Maps a whole capture in one pass. */
export function mapCodexAppServerStream(text: string, options?: MapperOptions): readonly AgentEvent[] {
  const mapper = new CodexAppServerMapper(options)
  const events: AgentEvent[] = []
  for (const line of text.split("\n")) events.push(...mapper.push(line))
  return events
}
