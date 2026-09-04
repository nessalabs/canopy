/** @responsibility States, as data, which `codex app-server` frame becomes which normalized event. */

import { AgentEventType } from "../../events"
import type { MappingEntry } from "../../mapping"
import { CodexAppServerItemType, CodexAppServerNotification, CodexAppServerRequest } from "./wire"

/**
 * The app-server's own table.
 *
 * Separate from `exec --json`'s because they are separate protocols against
 * the same contract. This one is the richer of the two: it reports work as it
 * happens where exec reports it settled.
 */
export const CODEX_APP_SERVER_MAPPING: Readonly<Record<string, MappingEntry>> = Object.freeze({
  [CodexAppServerRequest.Initialize]: {
    emits: [],
    note: "the handshake; its reply names the codex home and the platform, which is environment rather than conversation",
  },
  [CodexAppServerRequest.ThreadStart]: {
    emits: [],
    note: "the request; the `thread/started` notification is what announces the session",
  },
  [CodexAppServerRequest.TurnStart]: {
    emits: [AgentEventType.UserMessage],
    note: "the request carries the prompt, which `exec --json` never echoes",
  },
  [CodexAppServerRequest.TurnSteer]: {
    emits: [AgentEventType.UserMessage],
    note: "a message sent mid-turn, which is the steering exec cannot do",
  },
  [CodexAppServerRequest.TurnInterrupt]: {
    emits: [],
    note: "a client-side stop; the turn's own completion reports how it ended",
  },
  [CodexAppServerRequest.ThreadResume]: {
    emits: [],
    note: "reopens a thread; `thread/started` follows and announces it",
  },
  [CodexAppServerRequest.ThreadCompactStart]: {
    emits: [],
    note: "asks the agent to compact — the only transport of the seven that lets a client trigger it",
  },

  [CodexAppServerNotification.ThreadStarted]: {
    emits: [AgentEventType.SessionStarted],
    note: "the thread exists and is named",
  },
  [CodexAppServerNotification.ThreadStatusChanged]: {
    emits: [AgentEventType.StatusChanged],
    note: "active or idle, which is what says whether the agent is working",
  },
  [CodexAppServerNotification.ThreadTokenUsageUpdated]: {
    emits: [],
    note: "running totals; the turn's completion carries the counts that close it",
  },
  [CodexAppServerNotification.TurnStarted]: {
    emits: [],
    note: "a bare marker carrying nothing the turn's own events do not already say",
  },
  [CodexAppServerNotification.TurnCompleted]: {
    emits: [AgentEventType.TurnCompleted],
    note: "the terminator, carrying usage",
  },
  [CodexAppServerNotification.TurnPlanUpdated]: {
    emits: [AgentEventType.PlanUpdated],
    note: "the plan republished whole",
  },
  [CodexAppServerNotification.TurnDiffUpdated]: {
    emits: [],
    note: "the turn's accumulated diff; the file changes are already reported by the items that made them",
  },
  [CodexAppServerNotification.ItemAgentMessageDelta]: {
    emits: [AgentEventType.Delta],
    note: "the token stream — the thing `exec --json` does not send at all",
  },
  [CodexAppServerNotification.ItemPlanDelta]: {
    emits: [],
    note: "a partial plan, superseded by the update that publishes it whole",
  },
  [CodexAppServerNotification.ItemCommandExecutionOutputDelta]: {
    emits: [],
    note: "incremental command output; the item's completion carries the whole of it",
  },
  [CodexAppServerNotification.HookStarted]: {
    emits: [AgentEventType.Hook],
    note: "a hook fired",
  },
  [CodexAppServerNotification.HookCompleted]: {
    emits: [AgentEventType.Hook],
    note: "and what it returned",
  },
  [CodexAppServerNotification.McpServerStartupStatusUpdated]: {
    emits: [],
    note: "an MCP server coming up, which belongs to capabilities rather than to the conversation",
  },
  [CodexAppServerNotification.RemoteControlStatusChanged]: {
    emits: [],
    note: "whether this server is being driven remotely; nothing to do with the transcript",
  },
  [CodexAppServerNotification.Error]: {
    emits: [AgentEventType.Error],
    note: "a server-level failure outside any item",
  },

  // ---------- items ----------
  [`${CodexAppServerNotification.ItemStarted}/${CodexAppServerItemType.UserMessage}`]: {
    emits: [],
    note: "the prompt echoed back; the request that carried it already reported it",
  },
  [`${CodexAppServerNotification.ItemCompleted}/${CodexAppServerItemType.UserMessage}`]: {
    emits: [],
    note: "the same, settled",
  },
  [`${CodexAppServerNotification.ItemStarted}/${CodexAppServerItemType.AgentMessage}`]: {
    emits: [],
    note: "the message opens; its text arrives as deltas and is published whole on completion",
  },
  [`${CodexAppServerNotification.ItemCompleted}/${CodexAppServerItemType.AgentMessage}`]: {
    emits: [AgentEventType.AssistantText],
    note: "committed prose, superseding the deltas that previewed it",
  },
  [`${CodexAppServerNotification.ItemStarted}/${CodexAppServerItemType.Reasoning}`]: {
    emits: [],
    note: "reported whole on completion",
  },
  [`${CodexAppServerNotification.ItemCompleted}/${CodexAppServerItemType.Reasoning}`]: {
    emits: [AgentEventType.Reasoning],
    note: "committed reasoning",
  },
  [`${CodexAppServerNotification.ItemStarted}/${CodexAppServerItemType.CommandExecution}`]: {
    emits: [AgentEventType.ToolCallStarted],
    note: "a command begins; the item id is the call id",
  },
  [`${CodexAppServerNotification.ItemCompleted}/${CodexAppServerItemType.CommandExecution}`]: {
    emits: [AgentEventType.ToolCallCompleted],
    note: "output and exit code",
  },
  [`${CodexAppServerNotification.ItemStarted}/${CodexAppServerItemType.FileChange}`]: {
    emits: [AgentEventType.ToolCallStarted],
    note: "an edit begins",
  },
  [`${CodexAppServerNotification.ItemCompleted}/${CodexAppServerItemType.FileChange}`]: {
    emits: [AgentEventType.ToolCallCompleted, AgentEventType.FileEdits],
    note: "structured edits, the same as exec reports",
  },
  [`${CodexAppServerNotification.ItemStarted}/${CodexAppServerItemType.McpToolCall}`]: {
    emits: [AgentEventType.ToolCallStarted],
    note: "an MCP tool call begins",
  },
  [`${CodexAppServerNotification.ItemCompleted}/${CodexAppServerItemType.McpToolCall}`]: {
    emits: [AgentEventType.ToolCallCompleted],
    note: "and settles",
  },
  [`${CodexAppServerNotification.ItemStarted}/${CodexAppServerItemType.WebSearch}`]: {
    emits: [AgentEventType.ToolCallStarted],
    note: "a search begins",
  },
  [`${CodexAppServerNotification.ItemCompleted}/${CodexAppServerItemType.WebSearch}`]: {
    emits: [AgentEventType.ToolCallCompleted],
    note: "and settles",
  },
  [`${CodexAppServerNotification.ItemCompleted}/${CodexAppServerItemType.Todo}`]: {
    emits: [AgentEventType.PlanUpdated],
    note: "the plan as an item rather than a turn update",
  },
  [`${CodexAppServerNotification.ItemCompleted}/${CodexAppServerItemType.Error}`]: {
    emits: [AgentEventType.Error],
    note: "an item-level failure",
  },
})

/** The mapping key for one decoded frame. */
export function codexAppServerKind(method: string, itemType: string | null): string {
  if (method !== CodexAppServerNotification.ItemStarted && method !== CodexAppServerNotification.ItemCompleted) {
    return method
  }
  return itemType === null ? method : `${method}/${itemType}`
}

/** What a frame kind is declared to produce, or null for one nobody decided about. */
export function codexAppServerMappingFor(kind: string): MappingEntry | null {
  return CODEX_APP_SERVER_MAPPING[kind] ?? null
}
