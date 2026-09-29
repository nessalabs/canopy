import { z } from 'zod'

import type { AgentEvent } from '../agent-stream'
import { Millis } from './common'

export const AgentProvider = z.enum(['claude', 'codex'])
export type AgentProvider = z.infer<typeof AgentProvider>

export const Autonomy = z.enum(['read-only', 'edit', 'full'])
export type Autonomy = z.infer<typeof Autonomy>

/** Reasoning effort, as the Claude Agent SDK names it. */
export const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])
export type Effort = z.infer<typeof Effort>

/** Per-turn knobs shared by free-text messages and review bundles. */
export const TurnOptions = z.object({
  autonomy: Autonomy.optional(),
  /** Model alias or id ('opus', 'sonnet', …); the session's own model when omitted. */
  model: z.string().min(1).optional(),
  effort: Effort.optional(),
  /**
   * Where the turn's event numbering starts: the `nextSeq` of the transcript the client already
   * holds, so live events extend that log instead of colliding with it. Defaults to 0.
   */
  startSeq: z.number().int().nonnegative().optional()
})
export type TurnOptions = z.infer<typeof TurnOptions>

/** The checkout a session listed under another one actually ran in. */
export const SessionOrigin = z.object({
  /** `removed`: the worktree is gone; the transcript is still there and the session can continue. */
  kind: z.enum(['main', 'worktree', 'removed']),
  name: z.string(),
  path: z.string(),
  branch: z.string().nullable(),
  worktreeId: z.string().optional(),
  /** Where a message sent to it runs: its own checkout, or the main one when that is gone. */
  runIn: z.string()
})
export type SessionOrigin = z.infer<typeof SessionOrigin>

export const AgentSessionSummary = z.object({
  provider: AgentProvider,
  /** Provider-native id accepted by that provider's resume call. */
  sessionId: z.string(),
  title: z.string(),
  cwd: z.string().optional(),
  gitBranch: z.string().optional(),
  createdAt: Millis.optional(),
  /** Ranking key. */
  updatedAt: Millis,
  preview: z.string().optional(),
  transcriptPath: z.string().optional(),
  /** A terminal has this session open right now. */
  active: z.boolean().optional(),
  /**
   * What the session is doing this moment, when anything knows: `busy` while a turn is running
   * (its terminal says so, or its hooks reported a tool call seconds ago), `idle` when a terminal
   * has it open and is waiting for input. Absent when nothing is watching it.
   */
  status: z.enum(['busy', 'idle']).optional(),
  /**
   * The worktree this listing is for is not the session's own cwd: the session works here from
   * another checkout, and its hooks said so.
   */
  visiting: z.boolean().optional(),
  /**
   * Set when the session ran in another checkout of the same project and is listed here for
   * reference: every other checkout's sessions in the main checkout's tab (removed worktrees
   * included, so their conversations outlive them), and the main checkout's in a worktree's.
   */
  origin: SessionOrigin.optional()
})
export type AgentSessionSummary = z.infer<typeof AgentSessionSummary>

export const SessionRef = AgentSessionSummary.pick({ provider: true, sessionId: true })
export type SessionRef = z.infer<typeof SessionRef>


export const ImageMediaType = z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
export type ImageMediaType = z.infer<typeof ImageMediaType>

/** An inline image: base64 payload plus the `Image #N` label the text refers to it by. */
export const TurnImage = z.object({ label: z.string(), mediaType: ImageMediaType, data: z.string() })
export type TurnImage = z.infer<typeof TurnImage>

/** Context the user staged alongside a message; the agent receives it inside `text`. */
export const TurnAttachment = z.object({ kind: z.string(), label: z.string(), text: z.string() })
export type TurnAttachment = z.infer<typeof TurnAttachment>

/**
 * What Canopy knows about an event beyond its payload, keyed by the event's id: the images a user
 * turn carried, and the provider's own id for a user message — what a file rewind is addressed by.
 */
export const TurnExtras = z.object({
  images: z.array(TurnImage).optional(),
  /** The provider's uuid for this `user_message`, as the session file stores it. */
  messageId: z.string().optional()
})
export type TurnExtras = z.infer<typeof TurnExtras>

/**
 * One normalized agent-stream event as it crosses the wire. Only the envelope is validated; the
 * payload is a 28-arm union owned by the vendored parser, and a daemon newer than this client may
 * emit payload kinds it has never heard of — the fold renders those as nothing rather than failing
 * the whole stream, which zod mirrors of every arm would do.
 */
const isAgentEventEnvelope = (value: unknown): value is AgentEvent => {
  if (typeof value !== 'object' || value === null) return false
  const event = value as Record<string, unknown>
  const payload = event.payload as Record<string, unknown> | null | undefined
  return (
    typeof event.id === 'string' &&
    typeof event.sessionId === 'string' &&
    typeof event.seq === 'number' &&
    Array.isArray(event.agentPath) &&
    typeof payload === 'object' &&
    payload !== null &&
    typeof payload.type === 'string'
  )
}
export const AgentEventFrame = z.custom<AgentEvent>(isAgentEventEnvelope, { message: 'not an agent-stream event' })

/** A replayed session as an agent-stream event log, plus what it was running with. */
export const TranscriptResponse = z.object({
  /** Main conversation and delegated runs alike, in `seq` order, numbered from 0. */
  events: z.array(AgentEventFrame),
  /** Absolute paths each tool call wrote, by `callId` — edit-tool inputs or shell write targets. */
  files: z.record(z.string(), z.array(z.string())),
  /** Canopy-only data hung off an event, by event id (see `TurnExtras`). */
  extras: z.record(z.string(), TurnExtras),
  /** Model id of the last assistant turn (e.g. `claude-opus-5`). */
  model: z.string().optional(),
  effort: Effort.optional(),
  /**
   * A terminal has this session open. Turns sent from Canopy still go to the session (via the
   * Agent SDK), but that terminal will not show them until it resumes.
   */
  openInTerminal: z.boolean().optional(),
  /** The `startSeq` a live turn on top of this replay must use. */
  nextSeq: z.number().int().nonnegative()
})
export type TranscriptResponse = z.infer<typeof TranscriptResponse>

export const AgentStreamEvent = z.discriminatedUnion('type', [
  /** The session the turn runs in; for a new session, the id the agent assigned. Always first. */
  z.object({ type: z.literal('session'), provider: AgentProvider, sessionId: z.string() }),
  /** One agent-stream event (assistant text, tool calls, deltas, task progress, …). */
  z.object({ type: z.literal('event'), event: AgentEventFrame }),
  /** Absolute paths a tool call is about to write, so edits can be attributed to it. */
  z.object({ type: z.literal('files'), callId: z.string(), files: z.array(z.string()) }),
  /** Output tokens produced so far this turn; drives the live status line. */
  z.object({ type: z.literal('progress'), tokens: z.number() }),
  /** The provider's own id for a `user_message` event of this turn — what a rewind names. */
  z.object({ type: z.literal('message_id'), eventId: z.string(), messageId: z.string() }),
  /**
   * What the turn cost, from the SDK's result: an estimate in USD (absent on subscription
   * sessions where the CLI reports none), and how full the context window was on the last call.
   */
  z.object({
    type: z.literal('usage'),
    costUsd: z.number().nonnegative().optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    /** Tokens the last model call carried as context: input plus cache reads and writes. */
    contextTokens: z.number().int().nonnegative().optional(),
    contextWindow: z.number().int().positive().optional(),
    durationMs: z.number().int().nonnegative().optional()
  }),
  z.object({ type: z.literal('done'), sessionId: z.string() }),
  z.object({ type: z.literal('error'), message: z.string() })
])
export type AgentStreamEvent = z.infer<typeof AgentStreamEvent>

export const SendMessageInput = TurnOptions.extend({
  text: z.string().min(1),
  cwd: z.string().optional(),
  /** Sent to the agent as image blocks after the text. */
  images: z.array(TurnImage.omit({ label: true })).optional()
})
export type SendMessageInput = z.infer<typeof SendMessageInput>

/**
 * The user's answer to a `permission_requested` event. `allow` may rewrite the tool's input (the
 * SDK applies `updatedInput` in place of what the agent proposed); `deny` carries the reason the
 * agent is told, so it can try something else rather than guess why it was refused.
 */
export const PermissionDecisionInput = z.object({
  requestId: z.string().min(1),
  behavior: z.enum(['allow', 'deny']),
  message: z.string().optional(),
  updatedInput: z.record(z.string(), z.unknown()).optional()
})
export type PermissionDecisionInput = z.infer<typeof PermissionDecisionInput>

/** First turn of a brand-new session; it runs in the worktree's checkout. */
export const NewSessionInput = SendMessageInput.omit({ cwd: true }).extend({ provider: AgentProvider })
export type NewSessionInput = z.infer<typeof NewSessionInput>

// ---- what a session can do ----

/**
 * Where a slash command comes from, which is what the composer groups by.
 * `builtin` — Claude Code's own (`/compact`, `/context`, `/model`, …); `custom` — a `.claude/commands`
 * prompt of the user or project; `skill` — a SKILL.md; `plugin` — a `plugin:command`; `terminal` —
 * bound to a terminal's UX (`/color`, `/exit`), which a remote UI hides.
 */
export const CommandSource = z.enum(['builtin', 'custom', 'skill', 'plugin', 'terminal'])
export type CommandSource = z.infer<typeof CommandSource>

export const AgentCommand = z.object({
  /** As typed, without the leading slash. */
  name: z.string(),
  description: z.string(),
  /** Placeholder for what follows the name, e.g. `<file>`; empty when the command takes nothing. */
  argumentHint: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  source: CommandSource,
  /** The plugin supplying a `plugin:command`. */
  plugin: z.string().optional()
})
export type AgentCommand = z.infer<typeof AgentCommand>

export const AgentSkill = z.object({ name: z.string(), description: z.string().optional() })
export type AgentSkill = z.infer<typeof AgentSkill>

/** A subagent the session can delegate to, by `@agent-<name>` in a prompt or by the model's own choice. */
export const AgentSubagent = z.object({ name: z.string(), description: z.string(), model: z.string().optional() })
export type AgentSubagent = z.infer<typeof AgentSubagent>

export const AgentModel = z.object({
  /** What `model` accepts: an alias (`opus`) or a full id. */
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  /** The wire id the alias resolves to, so a session's detected model can be matched to its row. */
  resolvedModel: z.string().optional(),
  /** Empty when the model takes no effort parameter. */
  effortLevels: z.array(Effort)
})
export type AgentModel = z.infer<typeof AgentModel>

export const AgentMcpServer = z.object({ name: z.string(), status: z.string() })
export type AgentMcpServer = z.infer<typeof AgentMcpServer>

/** One hook as configured in settings: which event, an optional tool matcher, and what runs. */
export const AgentHook = z.object({
  event: z.string(),
  matcher: z.string().optional(),
  /** `command`, `http`, `prompt`, `agent`, `mcp_tool`, … */
  kind: z.string(),
  /** The command line or URL, for the kinds that have one. */
  target: z.string().optional(),
  /** Which settings file supplied it: `user`, `project`, `local`, `managed`, `flag`. */
  source: z.string().optional()
})
export type AgentHook = z.infer<typeof AgentHook>

export const AgentPlugin = z.object({ name: z.string(), version: z.string().optional(), path: z.string().optional() })
export type AgentPlugin = z.infer<typeof AgentPlugin>

export const AgentAccount = z.object({ email: z.string().optional(), organization: z.string().optional(), subscriptionType: z.string().optional() })
export type AgentAccount = z.infer<typeof AgentAccount>

/**
 * Everything a provider advertises about what a session in this checkout can do: the same lists
 * a terminal's `/` and `@` menus, `/model`, `/mcp`, `/agents` and `/hooks` show. Read lazily and
 * cached per checkout by the daemon; a live turn's own advertisement refreshes it.
 */
export const AgentCapabilities = z.object({
  provider: AgentProvider,
  cwd: z.string(),
  /** Provider version, e.g. the Claude Code CLI's. */
  version: z.string().optional(),
  model: z.string().optional(),
  permissionMode: z.string().optional(),
  outputStyle: z.string().optional(),
  outputStyles: z.array(z.string()),
  account: AgentAccount.optional(),
  commands: z.array(AgentCommand),
  skills: z.array(AgentSkill),
  agents: z.array(AgentSubagent),
  models: z.array(AgentModel),
  mcpServers: z.array(AgentMcpServer),
  tools: z.array(z.string()),
  plugins: z.array(AgentPlugin),
  hooks: z.array(AgentHook),
  readAt: Millis
})
export type AgentCapabilities = z.infer<typeof AgentCapabilities>

export const CapabilitiesQuery = z.object({
  provider: AgentProvider,
  /** Read as of this session where the provider can; otherwise the checkout's defaults. */
  session: z.string().optional(),
  /** `1` / `true` bypasses the daemon's cache. */
  refresh: z
    .enum(['1', 'true', '0', 'false'])
    .transform((value) => value === '1' || value === 'true')
    .optional()
})
export type CapabilitiesQuery = z.infer<typeof CapabilitiesQuery>

// ---- controlling a running turn ----

/** A prompt typed while a turn is running; the provider folds it into that turn. */
export const QueueMessageInput = z.object({
  text: z.string().min(1),
  images: z.array(TurnImage.omit({ label: true })).optional()
})
export type QueueMessageInput = z.infer<typeof QueueMessageInput>

/** Knobs that take effect mid-turn on the session's next model call. */
export const LiveControlsInput = z
  .object({
    model: z.string().min(1).optional(),
    autonomy: Autonomy.optional()
  })
  .refine((input) => input.model !== undefined || input.autonomy !== undefined, { message: 'nothing to change: give a model or an autonomy' })
export type LiveControlsInput = z.infer<typeof LiveControlsInput>

// ---- rewinding files ----

/**
 * Puts the worktree's files back to how they were before a user message was answered.
 *
 * Two mechanisms, and the caller picks by what it knows. With `tree` — the worktree tree Canopy's
 * hooks snapshotted before the turn's first write — every path that differs today is restored
 * from that tree, shell side effects included. Without it, the provider's own checkpoint is used
 * (Claude Code's `/rewind`), which covers only what its file tools wrote. `dryRun` reports what
 * would change and touches nothing.
 */
export const RewindInput = z.object({
  /** The `messageId` of the turn's `user_message` (see `TurnExtras`). */
  messageId: z.string().min(1),
  /** The worktree checkout the session ran in. */
  cwd: z.string().min(1),
  dryRun: z.boolean().optional(),
  /** Canopy's snapshot of the worktree before the turn wrote anything, when hooks recorded one. */
  tree: z.string().regex(/^[0-9a-f]{40,64}$/).optional()
})
export type RewindInput = z.infer<typeof RewindInput>

export const RewindResult = z.object({
  source: z.enum(['snapshot', 'checkpoint']),
  canRewind: z.boolean(),
  /** Why not, when `canRewind` is false. */
  error: z.string().optional(),
  /** Paths relative to the checkout that were (or, on a dry run, would be) restored or removed. */
  filesChanged: z.array(z.string()),
  insertions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional()
})
export type RewindResult = z.infer<typeof RewindResult>

/**
 * One file a tool call changed, as recorded by Canopy's hooks: the worktree trees before and
 * after the call. `attributed` is false when the call's own arguments never named the path —
 * likely another agent writing into the same worktree at the same moment.
 */
export const AgentEdit = z.object({
  toolUseId: z.string(),
  worktreeId: z.string(),
  path: z.string(),
  beforeTree: z.string(),
  afterTree: z.string(),
  attributed: z.boolean(),
  at: Millis
})
export type AgentEdit = z.infer<typeof AgentEdit>

export const AgentEditsResponse = z.object({ edits: z.array(AgentEdit) })
export type AgentEditsResponse = z.infer<typeof AgentEditsResponse>

export const SessionsResponse = z.object({
  sessions: z.array(AgentSessionSummary),
  pinned: SessionRef.optional()
})
export type SessionsResponse = z.infer<typeof SessionsResponse>
