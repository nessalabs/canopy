/**
 * Provider-neutral model for "the coding agent that worked in this worktree".
 * Canopy talks to Claude Code and Codex through the same three verbs:
 *   list       — which sessions ran in this worktree's checkout
 *   transcript — replay one of them into the Agent tab
 *   send       — resume it (or start a fresh one when sessionId is null) and append a user turn
 * Wire types live in @canopy/shared so the UI renders exactly what the daemon emits.
 */
import type { AgentProvider, AgentSessionSummary, AgentStreamEvent, TranscriptResponse, TurnImage, TurnOptions } from '@canopy/shared'

export type { AgentProvider, AgentSessionSummary, AgentStreamEvent, TranscriptResponse }

export interface SendOptions extends TurnOptions {
  /** Worktree checkout the turn should run in. Defaults to the session's own cwd. */
  cwd?: string
  /** Images to send as content blocks after the text. */
  images?: Array<Omit<TurnImage, 'label'>>
  signal?: AbortSignal
}

export interface AgentAdapter {
  readonly provider: AgentProvider
  /** False when the provider's CLI/SDK isn't installed or authenticated. */
  available(): Promise<boolean>
  listSessions(cwd: string, limit?: number): Promise<AgentSessionSummary[]>
  transcript(sessionId: string, cwd?: string): Promise<TranscriptResponse>
  send(sessionId: string | null, text: string, options?: SendOptions): AsyncIterable<AgentStreamEvent>
}
