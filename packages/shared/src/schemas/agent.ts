import { z } from 'zod'

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
  /** True while a terminal has this session open; turns sent from Canopy go to that terminal. */
  live: z.boolean().optional()
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
  active: z.boolean().optional()
})
export type AgentSessionSummary = z.infer<typeof AgentSessionSummary>

export const SessionRef = AgentSessionSummary.pick({ provider: true, sessionId: true })
export type SessionRef = z.infer<typeof SessionRef>

export const TranscriptRole = z.enum(['user', 'assistant', 'reasoning', 'tool', 'system'])
export type TranscriptRole = z.infer<typeof TranscriptRole>

export const ImageMediaType = z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
export type ImageMediaType = z.infer<typeof ImageMediaType>

/** An inline image: base64 payload plus the `Image #N` label the text refers to it by. */
export const TurnImage = z.object({ label: z.string(), mediaType: ImageMediaType, data: z.string() })
export type TurnImage = z.infer<typeof TurnImage>

/** Context the user staged alongside a message; the agent receives it inside `text`. */
export const TurnAttachment = z.object({ kind: z.string(), label: z.string(), text: z.string() })
export type TurnAttachment = z.infer<typeof TurnAttachment>

export const TranscriptItem = z.object({
  id: z.string(),
  role: TranscriptRole,
  /** The full content as the agent saw it. */
  text: z.string(),
  at: Millis.optional(),
  /** Tool name for role 'tool'. */
  tool: z.string().optional(),
  /** Human summary of a tool call when the agent gave one (e.g. Bash's `description`). */
  title: z.string().optional(),
  /** For user turns composed in Canopy: what was typed, shown instead of `text`. */
  display: z.string().optional(),
  attachments: z.array(TurnAttachment).optional(),
  images: z.array(TurnImage).optional(),
  /** Absolute paths a tool call wrote (edit-tool inputs, or parsed from a shell command). */
  files: z.array(z.string()).optional(),
  /** The provider's id for a tool call, joining it to `AgentEdit` snapshots. */
  toolUseId: z.string().optional()
})
export type TranscriptItem = z.infer<typeof TranscriptItem>

/** A replayed session plus what it was running with, so the composer can default to it. */
export const Transcript = z.object({
  items: z.array(TranscriptItem),
  /** Model id of the last assistant turn (e.g. `claude-opus-5`). */
  model: z.string().optional(),
  effort: Effort.optional(),
  /** True while a terminal has this session open; turns sent from Canopy go to that terminal. */
  live: z.boolean().optional()
})
export type Transcript = z.infer<typeof Transcript>

export const AgentStreamEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session'), provider: AgentProvider, sessionId: z.string() }),
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({ type: z.literal('item'), item: TranscriptItem }),
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
