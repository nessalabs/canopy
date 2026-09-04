/** @responsibility Describes what a session can do, in one shape every provider fills as much of as its wire allows. */

import type { ToolKind } from "./events"

/**
 * What a session advertises about itself.
 *
 * One shape rather than one per provider, for the reason the event contract is
 * shared: a composer's pickers should be written once. **Null means "this
 * provider cannot report it"** — never "none exist" — so a surface can omit a
 * section rather than render an empty one, and adding a provider does not add a
 * branch to the consumer.
 *
 * Where the answer comes from is each provider's business. Claude Code
 * advertises itself on its event stream; Codex answers a separate interactive
 * channel. Both end here.
 */
export interface AgentCapabilities {
  readonly sessionId: string | null
  readonly model: string | null
  readonly cwd: string | null
  readonly permissionMode: string | null
  /** Models the session could switch to. */
  readonly models: readonly CapabilityModel[] | null
  /** Slash commands, whatever supplies them. */
  readonly commands: readonly CapabilityCommand[] | null
  readonly skills: readonly CapabilitySkill[] | null
  /** Delegated agents that can be spawned by name. */
  readonly agents: readonly string[] | null
  readonly tools: readonly CapabilityTool[] | null
  readonly mcpServers: readonly CapabilityServer[] | null
  /** Plugins installed into this session. */
  readonly plugins: readonly CapabilityPlugin[] | null
  /** Catalogues a plugin could be installed from, which a picker searches rather than lists. */
  readonly pluginSources: readonly CapabilityPluginSource[] | null
  readonly hooks: readonly CapabilityHook[] | null
}

/** Where a slash command comes from, which is what a picker groups by. */
export type CommandSource = "skill" | "plugin" | "session" | "terminal"

export interface CapabilityCommand {
  /** As typed, without the leading slash. */
  readonly name: string
  readonly source: CommandSource
  /** The plugin that supplies it, for a `plugin:command` name. */
  readonly plugin: string | null
}

export interface CapabilityModel {
  readonly id: string
  readonly label: string
  readonly description: string | null
  readonly isDefault: boolean
}

export interface CapabilitySkill {
  readonly name: string
  readonly description: string | null
}

export interface CapabilityTool {
  readonly name: string
  readonly kind: ToolKind
  /** The MCP server that supplies it, where the name says so. */
  readonly server: string | null
  /**
   * True when the tool was absent from the session's first advertisement and
   * appeared later — which is what a deferred tool loading on demand looks
   * like from outside.
   */
  readonly deferred: boolean
}

export interface CapabilityServer {
  readonly name: string
  readonly status: string
  /** The only status that means the tools are usable now. */
  readonly connected: boolean
  readonly tools: readonly string[]
}

export interface CapabilityPlugin {
  readonly name: string
  readonly version: string | null
  readonly source: string | null
}

export interface CapabilityPluginSource {
  readonly name: string
  /** The catalogue's real size, which can be far larger than what a reply carried. */
  readonly count: number
  /** What the reply actually returned, when it returned a sample. */
  readonly sample: readonly string[]
}

export interface CapabilityHook {
  readonly event: string | null
  readonly source: string | null
}

/** Every section a provider left unreported, for a surface that wants to say so. */
export function unreportedCapabilities(capabilities: AgentCapabilities): readonly string[] {
  const sections: readonly (readonly [string, unknown])[] = [
    ["models", capabilities.models],
    ["commands", capabilities.commands],
    ["skills", capabilities.skills],
    ["agents", capabilities.agents],
    ["tools", capabilities.tools],
    ["MCP servers", capabilities.mcpServers],
    ["plugins", capabilities.plugins],
    ["plugin sources", capabilities.pluginSources],
    ["hooks", capabilities.hooks],
  ]
  return sections.filter(([, value]) => value === null).map(([name]) => name)
}
