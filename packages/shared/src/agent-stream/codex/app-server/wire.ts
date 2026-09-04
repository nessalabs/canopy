/** @responsibility Describes the `codex app-server` JSON-RPC envelope and decodes one frame into it without interpreting it. */

import type { WireProvenance } from "../../events"
import { parseJsonObjectLine } from "../../json"
import type { JsonValue } from "../../json"

/**
 * The build this envelope was read from.
 *
 * The app-server publishes its own schema — `codex app-server
 * generate-json-schema` — so unlike `exec --json` the vocabulary is knowable
 * without a capture. What still needs recording is the build it was generated
 * from, because the schema moves with the CLI.
 */
export const CODEX_APP_SERVER_PROVENANCE: WireProvenance = Object.freeze({
  cli: "codex-cli",
  version: "0.144.1",
  command: "codex app-server",
  capturedOn: "2026-08-29",
})

/**
 * The client requests this reader recognises.
 *
 * The schema declares 87 of them, most about managing threads, plugins and
 * accounts rather than about a conversation. These are the ones a transcript
 * depends on; the rest reach a consumer as unknown, which is the honest
 * default for a protocol this wide.
 */
export const CodexAppServerRequest = Object.freeze({
  Initialize: "initialize",
  ThreadStart: "thread/start",
  ThreadResume: "thread/resume",
  ThreadCompactStart: "thread/compact/start",
  TurnStart: "turn/start",
  TurnSteer: "turn/steer",
  TurnInterrupt: "turn/interrupt",
} as const)

export type CodexAppServerRequest = (typeof CodexAppServerRequest)[keyof typeof CodexAppServerRequest]

/**
 * The notifications the server sends.
 *
 * Where `exec --json` reports items only once they settle, this reports the
 * same work as it happens — including the token deltas that mode never sends.
 */
export const CodexAppServerNotification = Object.freeze({
  ThreadStarted: "thread/started",
  ThreadStatusChanged: "thread/status/changed",
  ThreadTokenUsageUpdated: "thread/tokenUsage/updated",
  TurnStarted: "turn/started",
  TurnCompleted: "turn/completed",
  TurnPlanUpdated: "turn/plan/updated",
  TurnDiffUpdated: "turn/diff/updated",
  ItemStarted: "item/started",
  ItemCompleted: "item/completed",
  /** The token stream. */
  ItemAgentMessageDelta: "item/agentMessage/delta",
  ItemPlanDelta: "item/plan/delta",
  ItemCommandExecutionOutputDelta: "item/commandExecution/outputDelta",
  HookStarted: "hook/started",
  HookCompleted: "hook/completed",
  McpServerStartupStatusUpdated: "mcpServer/startupStatus/updated",
  RemoteControlStatusChanged: "remoteControl/status/changed",
  Error: "error",
} as const)

export type CodexAppServerNotification =
  (typeof CodexAppServerNotification)[keyof typeof CodexAppServerNotification]

/** The item kinds carried by `item/started` and `item/completed`. */
export const CodexAppServerItemType = Object.freeze({
  UserMessage: "userMessage",
  AgentMessage: "agentMessage",
  Reasoning: "reasoning",
  CommandExecution: "commandExecution",
  FileChange: "fileChange",
  McpToolCall: "mcpToolCall",
  WebSearch: "webSearch",
  Todo: "todo",
  Error: "error",
} as const)

export type CodexAppServerItemType = (typeof CodexAppServerItemType)[keyof typeof CodexAppServerItemType]

/** Any decoded frame, before anything past "it is an object" has been checked. */
export interface CodexAppServerFrame {
  readonly [key: string]: JsonValue | undefined
}

export interface CodexAppServerParseFailure {
  readonly ok: false
  readonly line: string
  readonly reason: string
}

export interface CodexAppServerParseSuccess {
  readonly ok: true
  /** An object, and nothing further verified — a JSON-RPC frame carries no `type`. */
  readonly line: CodexAppServerFrame
}

export type CodexAppServerParseResult = CodexAppServerParseSuccess | CodexAppServerParseFailure

/** One frame of newline-delimited JSON-RPC. A blank line is not a frame. */
export function parseCodexAppServerLine(line: string): CodexAppServerParseResult | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  const result = parseJsonObjectLine(trimmed)
  return result.ok ? { ok: true, line: result.line as CodexAppServerFrame } : result
}

/** Decodes a whole capture, dropping only blank lines. */
export function parseCodexAppServer(text: string): readonly CodexAppServerParseResult[] {
  const results: CodexAppServerParseResult[] = []
  for (const line of text.split("\n")) {
    const result = parseCodexAppServerLine(line)
    if (result !== null) results.push(result)
  }
  return results
}
