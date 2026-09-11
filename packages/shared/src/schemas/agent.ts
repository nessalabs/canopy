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
  visiting: z.boolean().optional()
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
  /** Canopy-only data hung off an event: the images a user turn carried. */
  extras: z.record(z.string(), z.object({ images: z.array(TurnImage) })),
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
