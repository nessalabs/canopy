/** @responsibility Classifies harness tool names and summarizes one call's arguments for a transcript row. */

import type { ToolKind } from "../events"
import { asRecord, asString, shortenPath } from "../json"
import type { JsonValue } from "./stream/wire"

const KINDS: ReadonlyArray<readonly [ToolKind, ReadonlySet<string>]> = [
  ["shell", new Set(["Bash", "BashOutput", "KillShell", "shell", "local_shell_call"])],
  ["file_read", new Set(["Read", "NotebookRead", "view"])],
  ["file_edit", new Set(["Edit", "Write", "NotebookEdit", "MultiEdit", "apply_patch"])],
  ["search", new Set(["Glob", "Grep", "ToolSearch", "SearchSkills", "SearchPlugins"])],
  ["web", new Set(["WebFetch", "WebSearch"])],
  ["plan", new Set(["TodoWrite", "ExitPlanMode", "EnterPlanMode"])],
  ["subagent", new Set(["Task", "Agent"])],
  ["workflow", new Set(["Workflow"])],
]

/**
 * Maps a tool name to its rendering hint.
 *
 * Name-based rather than shape-based on purpose: the wire gives no kind, and a
 * name is stable in a way that argument shapes are not. Anything unrecognized —
 * including every MCP tool past the `mcp__` prefix — falls through to a kind
 * that must still render.
 */
export function toolKind(name: string): ToolKind {
  if (name.startsWith("mcp__")) return "mcp"
  for (const [kind, names] of KINDS) if (names.has(name)) return kind
  return "other"
}

/** One string argument off a tool's input, or null when it is absent or another shape. */
function field(input: JsonValue, key: string): string | null {
  return asString(asRecord(input)[key])
}

export { shortenPath } from "../json"

/**
 * One line naming what a call does, from its own arguments.
 *
 * Derived at map time rather than at render time so the summary travels with
 * the event — a consumer replaying a persisted log gets the same row without
 * re-deriving it, and a tool whose arguments never finished streaming still has
 * something to show.
 */
export function toolTitle(name: string, input: JsonValue): string {
  const kind = toolKind(name)
  switch (kind) {
    case "shell": {
      const description = field(input, "description")
      const command = field(input, "command")
      return description ?? (command === null ? name : command.split("\n")[0]!)
    }
    case "file_read":
    case "file_edit": {
      const path = field(input, "file_path") ?? field(input, "path") ?? field(input, "notebook_path")
      return path === null ? name : shortenPath(path)
    }
    case "search": {
      const pattern = field(input, "pattern") ?? field(input, "query")
      return pattern === null ? name : pattern
    }
    case "web": {
      const url = field(input, "url")
      const query = field(input, "query")
      return url ?? query ?? name
    }
    case "subagent": {
      const description = field(input, "description")
      const type = field(input, "subagent_type")
      if (description !== null && type !== null) return `${type}: ${description}`
      return description ?? type ?? name
    }
    case "workflow":
      return field(input, "name") ?? "Workflow"
    case "plan":
      return "Updated plan"
    case "mcp": {
      const [, server, tool] = name.split("__")
      return tool === undefined ? name : `${server}: ${tool}`
    }
    default:
      return name
  }
}

/** The verb a row uses for a tool, in the tense its status calls for. */
export function toolVerb(name: string, running: boolean): string {
  switch (toolKind(name)) {
    case "shell":
      return running ? "Running" : "Ran"
    case "file_read":
      return running ? "Reading" : "Read"
    case "file_edit":
      return running ? "Editing" : "Edited"
    case "search":
      return running ? "Searching" : "Searched"
    case "web":
      return running ? "Fetching" : "Fetched"
    case "subagent":
      return running ? "Delegating" : "Delegated"
    case "workflow":
      return running ? "Orchestrating" : "Orchestrated"
    case "plan":
      return running ? "Planning" : "Planned"
    default:
      return running ? "Calling" : "Called"
  }
}
