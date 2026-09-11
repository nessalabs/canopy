import type { AccountInfo, AgentInfo, McpServerStatus, ModelInfo, SlashCommand } from '@anthropic-ai/claude-agent-sdk'

import type { AgentCapabilities, AgentCommand, AgentHook, AgentMcpServer, AgentModel, AgentPlugin, AgentSkill, CommandSource, Effort } from '@canopy/shared'

import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { ApiError } from '../lib/errors'
import { now } from '../lib/ids'
import type { SdkModule } from './claude'

/**
 * What a Claude session in a given checkout can do: the same lists a terminal's `/` and `@` menus,
 * `/model`, `/mcp`, `/agents` and `/hooks` show.
 *
 * Two sources, because neither is complete on its own:
 *
 *  - an **idle probe** — `query()` with a prompt generator that never yields, so the CLI starts,
 *    answers `initializationResult()` (~0.7 s warm, ~1.1 s cold) and is shut down again without a
 *    single model call. It carries the commands, subagents, models, account and output styles.
 *  - a **live turn's `system/init`** — measured, the idle probe never emits one, because init is
 *    per turn. So the fields only init carries (skills, tools, plugins, terminal-only commands, the
 *    CLI version, the session's model and mode) are folded in from whatever turn last ran in that
 *    checkout, and are simply empty until one has.
 *
 * Both are cached per cwd. Nothing here runs at boot: the first `GET …/agent/capabilities` pays for
 * the probe, and everyone after it is served from the cache until the TTL lapses.
 */

/** Long enough that a session's `/` menu never waits twice, short enough to notice a new skill. */
const TTL_MS = 10 * 60 * 1000
/** A probe that has not answered by now is a CLI that is wedged, not one that is slow. */
const PROBE_TIMEOUT_MS = 20_000

/** The half of the answer the idle probe knows. */
interface Probed {
  commands: SlashCommand[]
  agents: AgentInfo[]
  models: ModelInfo[]
  account?: AccountInfo
  outputStyle?: string
  outputStyles: string[]
  mcpServers: AgentMcpServer[]
  at: number
}

/** The half only a turn's own `system/init` knows. Survives a probe refresh; a turn refreshes it. */
interface Advertised {
  skills: string[]
  terminalCommands: string[]
  tools: string[]
  plugins: AgentPlugin[]
  version?: string
  model?: string
  permissionMode?: string
  outputStyle?: string
  mcpServers: AgentMcpServer[]
  /** A mid-session `commands_changed` replaces the probe's list wholesale. */
  commands?: SlashCommand[]
}

/** The `system/init` fields this reads, as they arrive on the wire. */
export interface InitAdvertisement {
  skills?: string[]
  slash_commands?: string[]
  terminal_slash_commands?: string[]
  tools?: string[]
  plugins?: Array<{ name?: string; path?: string; version?: string }>
  mcp_servers?: Array<{ name?: string; status?: string }>
  claude_code_version?: string
  model?: string
  permissionMode?: string
  output_style?: string
}

interface Entry {
  probed?: Probed
  advertised?: Advertised
}

const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']
/** `/name (user)` and `/name (project)` are how the CLI marks a prompt file as someone's own. */
const AUTHORED = /\s*\((user|project)\)\s*$/

export class ClaudeCapabilities {
  private readonly entries = new Map<string, Entry>()

  constructor(
    private readonly loadSdk: () => Promise<SdkModule | undefined>,
    private readonly ttlMs = TTL_MS
  ) {}

  /** Folds a live turn's `system/init` into the checkout's entry — the fields no probe can see. */
  observeInit(cwd: string | undefined, init: InitAdvertisement): void {
    if (!cwd) return
    const entry = this.entryFor(cwd)
    entry.advertised = {
      skills: init.skills ?? [],
      terminalCommands: init.terminal_slash_commands ?? [],
      tools: init.tools ?? [],
      plugins: (init.plugins ?? []).flatMap((plugin) => (plugin.name ? [{ name: plugin.name, version: plugin.version, path: plugin.path }] : [])),
      version: init.claude_code_version,
      model: init.model,
      permissionMode: init.permissionMode,
      outputStyle: init.output_style,
      mcpServers: (init.mcp_servers ?? []).flatMap((server) => (server.name ? [{ name: server.name, status: server.status ?? 'unknown' }] : [])),
      // A `commands_changed` seen earlier in this same turn stays authoritative.
      commands: entry.advertised?.commands
    }
  }

  /** `system/commands_changed`: the CLI's own instruction is to replace the cached list. */
  observeCommands(cwd: string | undefined, commands: SlashCommand[]): void {
    if (!cwd) return
    const entry = this.entryFor(cwd)
    entry.advertised = { ...(entry.advertised ?? emptyAdvertisement()), commands }
  }

  async read(cwd: string, opts: { sessionId?: string; refresh?: boolean } = {}): Promise<AgentCapabilities> {
    const module = await this.loadSdk()
    if (!module) throw new ApiError(503, 'capabilities_unavailable', '@anthropic-ai/claude-agent-sdk is not installed')

    const entry = this.entryFor(cwd)
    const cached = entry.probed !== undefined && now() - entry.probed.at < this.ttlMs ? entry.probed : undefined
    const probed = opts.refresh || !cached ? await probe(module, cwd) : cached
    entry.probed = probed

    // A hook listing that fails is a settings file this daemon could not read — not a reason to
    // withhold every command, model and subagent the session actually has.
    const [hooks, onDisk] = await Promise.all([readHooks(module, cwd), entry.advertised?.skills.length ? Promise.resolve([]) : skillDirectories(cwd)])
    return assemble(cwd, probed, entry.advertised, hooks, onDisk)
  }

  private entryFor(cwd: string): Entry {
    const entry = this.entries.get(cwd) ?? {}
    this.entries.set(cwd, entry)
    return entry
  }
}

const emptyAdvertisement = (): Advertised => ({ skills: [], terminalCommands: [], tools: [], plugins: [], mcpServers: [] })

/**
 * Starts a CLI, asks it what it knows, and shuts it down. The prompt generator is the trick: it
 * parks on a gate that is only released in the `finally`, so the SDK has a prompt stream that never
 * produces a message and therefore never runs a turn. Nothing is resumed — the answer is about the
 * checkout, and resuming a session would pay to reload its whole transcript for the same lists.
 */
async function probe(module: SdkModule, cwd: string): Promise<Probed> {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => (release = resolve))
  async function* idle(): AsyncGenerator<never> {
    await gate
  }

  const query = module.query({ prompt: idle(), options: { cwd, permissionMode: 'plan' } })
  try {
    const read = (async (): Promise<Probed> => {
      const init = await query.initializationResult()
      // One round trip each, and none of them depends on another.
      const [models, agents, mcpServers] = await Promise.all([query.supportedModels(), query.supportedAgents(), query.mcpServerStatus()])
      return {
        commands: init.commands ?? [],
        agents: agents.length > 0 ? agents : (init.agents ?? []),
        models: models.length > 0 ? models : (init.models ?? []),
        account: init.account,
        outputStyle: init.output_style,
        outputStyles: init.available_output_styles ?? [],
        mcpServers: mcpServers.map((server: McpServerStatus) => ({ name: server.name, status: server.status })),
        at: now()
      }
    })()
    return await Promise.race([read, timeout()])
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(503, 'capabilities_unavailable', `claude: could not read capabilities for ${cwd}: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    release?.()
    // Releasing the gate ends the prompt stream; returning closes the query and the CLI with it.
    await Promise.resolve(query.return(undefined)).catch(() => undefined)
  }
}

function timeout(): Promise<never> {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new ApiError(503, 'capabilities_unavailable', `claude: the capability probe did not answer within ${PROBE_TIMEOUT_MS}ms`)), PROBE_TIMEOUT_MS)
    timer.unref?.()
  })
}

/**
 * Skill names by their directories, for a checkout no turn has advertised yet: `~/.claude/skills`
 * and `<cwd>/.claude/skills`, one `SKILL.md` per subdirectory. Two readdirs, so cheap enough to
 * pay on every read until a turn's init supersedes it; plugin skills are not here, but those
 * carry a `plugin:` name and classify themselves.
 */
async function skillDirectories(cwd: string): Promise<string[]> {
  const roots = [join(homedir(), '.claude', 'skills'), join(cwd, '.claude', 'skills')]
  const found = await Promise.all(
    roots.map((root) => readdir(root, { withFileTypes: true }).then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)).catch(() => [] as string[]))
  )
  return [...new Set(found.flat())]
}

function assemble(cwd: string, probed: Probed, advertised: Advertised | undefined, hooks: AgentHook[], onDisk: string[] = []): AgentCapabilities {
  const live = advertised ?? emptyAdvertisement()
  // A turn's init is authoritative; before one has run, the skill directories stand in.
  const skillNames = live.skills.length > 0 ? live.skills : onDisk.filter((name) => probed.commands.some((command) => command.name === name))
  const skills = new Set(skillNames)
  const terminal = new Set(live.terminalCommands)
  const commands = (live.commands ?? probed.commands).map((command) => classify(command, skills, terminal))
  const described = new Map(commands.map((command) => [command.name, command.description] as const))

  return {
    provider: 'claude',
    cwd,
    version: live.version,
    model: live.model,
    permissionMode: live.permissionMode,
    outputStyle: live.outputStyle ?? probed.outputStyle,
    outputStyles: probed.outputStyles,
    account: probed.account ? { email: probed.account.email, organization: probed.account.organization, subscriptionType: probed.account.subscriptionType } : undefined,
    commands,
    // A skill's prose comes from the matching command; only its name says it is one.
    skills: skillNames.map((name): AgentSkill => ({ name, description: described.get(name) })),
    agents: probed.agents.map((agent) => ({ name: agent.name, description: agent.description, model: agent.model })),
    models: probed.models.map(toModel),
    // The probe asked the CLI just now; a turn's init is the fallback for a probe that saw none.
    mcpServers: probed.mcpServers.length > 0 ? probed.mcpServers : live.mcpServers,
    tools: live.tools,
    plugins: live.plugins,
    hooks,
    readAt: probed.at
  }
}

/**
 * Which menu a command belongs under. The CLI does not label them, so this reads the shape it does
 * give: a `plugin:command` name, membership of the turn's `skills` or `terminal_slash_commands`
 * lists, and the `(user)` / `(project)` suffix it appends to anything read off a prompt file.
 */
function classify(command: SlashCommand, skills: Set<string>, terminal: Set<string>): AgentCommand {
  const authored = AUTHORED.exec(command.description)
  let description = authored ? command.description.slice(0, authored.index).trimEnd() : command.description

  const colon = command.name.indexOf(':')
  const plugin = colon > 0 ? command.name.slice(0, colon) : undefined
  const source: CommandSource = plugin ? 'plugin' : skills.has(command.name) ? 'skill' : terminal.has(command.name) ? 'terminal' : authored ? 'custom' : 'builtin'
  // A plugin's own commands are prefixed with `(plugin-name)`; the grouping already says that.
  if (plugin && description.startsWith(`(${plugin}) `)) description = description.slice(plugin.length + 3)

  return {
    name: command.name,
    description,
    argumentHint: command.argumentHint || undefined,
    aliases: command.aliases?.length ? command.aliases : undefined,
    source,
    plugin
  }
}

const toModel = (model: ModelInfo): AgentModel => ({
  id: model.value,
  label: model.displayName,
  description: model.description,
  resolvedModel: model.resolvedModel,
  effortLevels: (model.supportedEffortLevels ?? []).filter((effort): effort is Effort => EFFORTS.includes(effort))
})

/** One settings-file hook block, as `resolveSettings` reports it. */
interface HookMatcher {
  matcher?: string
  hooks?: Array<{ type?: string; command?: string; url?: string }>
}

/**
 * The configured hooks, flattened. `resolveSettings` merges the same cascade the CLI does without
 * starting one, so this costs a few file reads rather than another CLI.
 */
async function readHooks(module: SdkModule, cwd: string): Promise<AgentHook[]> {
  try {
    if (typeof module.resolveSettings !== 'function') return []
    const resolved = await module.resolveSettings({ cwd })
    const effective = (resolved.effective?.hooks ?? {}) as Record<string, HookMatcher[] | undefined>
    const sources = resolved.sources ?? []
    const fallback = resolved.provenance?.hooks?.source

    // `sources` runs low→high precedence, so the last one that mentions an event is the one whose
    // file a reader would open first — finer than the single per-key provenance entry.
    const sourceOf = (event: string): string | undefined => {
      let found = fallback as string | undefined
      for (const source of sources) {
        const hooks = (source.settings?.hooks ?? {}) as Record<string, unknown>
        if (hooks[event]) found = source.source
      }
      return found
    }

    return Object.entries(effective).flatMap(([event, matchers]) =>
      (matchers ?? []).flatMap((matcher) =>
        (matcher.hooks ?? []).map((hook) => ({ event, matcher: matcher.matcher, kind: hook.type ?? 'command', target: hook.command ?? hook.url, source: sourceOf(event) }))
      )
    )
  } catch {
    return []
  }
}
