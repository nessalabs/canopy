/** @responsibility Derives what a session can do — commands, skills, agents, tools and MCP servers — for a composer's pickers. */

import type {
  AgentCapabilities,
  CapabilityCommand,
  CapabilityServer,
  CapabilityTool,
} from "../../capabilities"
import type { AgentEvent, SessionInfo } from "../../events"
import { toolKind } from "../tools"

/**
 * The prefix an MCP tool carries, normalized for comparison against a server's
 * display name.
 *
 * The two disagree on purpose: a server named "example Mail" contributes
 * `mcp__example_Mail__get_message`, so matching them means flattening both
 * sides to the same alphabet rather than comparing strings.
 */
function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "")
}

/** Splits `mcp__server__tool` into its server, or null for a first-party tool. */
export function mcpServerOf(toolName: string): string | null {
  if (!toolName.startsWith("mcp__")) return null
  const rest = toolName.slice("mcp__".length)
  const separator = rest.indexOf("__")
  return separator === -1 ? rest : rest.slice(0, separator)
}

function classifyCommand(name: string, skills: ReadonlySet<string>): CapabilityCommand {
  const [head, tail] = name.split(":")
  if (tail !== undefined) return { name, source: "plugin", plugin: head! }
  if (skills.has(name)) return { name, source: "skill", plugin: null }
  return { name, source: "session", plugin: null }
}

/**
 * Folds every `init` in a log into one description of the session.
 *
 * Merged rather than replaced, because the tool list **grows between inits**:
 * deferred tools load on demand, so the last `init` is not a superset of the
 * first in any guaranteed way and treating either one as the answer loses
 * entries. What the first init did *not* carry is reported as `deferred`, which
 * is the only signal the stream gives that a tool arrived late.
 */
export function sessionCapabilities(events: readonly AgentEvent[]): AgentCapabilities | null {
  const inits: SessionInfo[] = []
  for (const event of events) {
    if (event.payload.type === "session_started") inits.push(event.payload.session)
  }
  if (inits.length === 0) return null

  const first = inits[0]!
  const latest = inits[inits.length - 1]!
  const firstTools = new Set(first.tools)

  const toolNames = new Set<string>()
  for (const init of inits) for (const name of init.tools) toolNames.add(name)

  const tools: CapabilityTool[] = [...toolNames].map((name) => ({
    name,
    kind: toolKind(name),
    server: mcpServerOf(name),
    deferred: !firstTools.has(name),
  }))

  const servers = new Map<string, CapabilityServer>()
  for (const init of inits) {
    for (const server of init.mcpServers) {
      const matched = tools.filter((tool) => tool.server !== null && slug(tool.server) === slug(server.name))
      servers.set(server.name, {
        name: server.name,
        status: server.status,
        connected: server.status === "connected",
        tools: matched.map((tool) => tool.name),
      })
    }
  }

  const skills = new Set<string>()
  for (const init of inits) for (const skill of init.skills) skills.add(skill)

  const commands = new Map<string, CapabilityCommand>()
  for (const init of inits) {
    for (const name of init.slashCommands) commands.set(name, classifyCommand(name, skills))
    for (const name of init.terminalSlashCommands) commands.set(name, { name, source: "terminal", plugin: null })
  }

  const agents = new Set<string>()
  for (const init of inits) for (const agent of init.agents) agents.add(agent)

  return {
    sessionId: latest.sessionId,
    model: latest.model,
    cwd: latest.cwd,
    permissionMode: latest.permissionMode,
    commands: [...commands.values()],
    skills: [...skills].map((name) => ({ name, description: null })),
    agents: [...agents],
    tools,
    mcpServers: [...servers.values()],
    plugins: latest.plugins.map((plugin) => ({
      name: plugin.name,
      version: plugin.version,
      source: plugin.source,
    })),
    // Null rather than empty: the CLI does not advertise the models a session
    // could switch to, or the catalogues a plugin came from, so a picker omits
    // those sections here rather than showing them bare.
    models: null,
    pluginSources: null,
    hooks: null,
  }
}

/** Groups tools for a picker: first-party tools by kind, MCP tools by their server. */
export function groupTools(capabilities: AgentCapabilities): ReadonlyMap<string, readonly CapabilityTool[]> {
  const groups = new Map<string, CapabilityTool[]>()
  for (const tool of capabilities.tools ?? []) {
    const key = tool.server === null ? tool.kind : `mcp:${tool.server}`
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [tool])
    else bucket.push(tool)
  }
  return groups
}
