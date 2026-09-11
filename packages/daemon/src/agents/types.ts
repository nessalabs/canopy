/**
 * Provider-neutral model for "the coding agent that worked in this worktree".
 * Canopy talks to Claude Code and Codex through the same three verbs:
 *   list       — which sessions ran in this worktree's checkout
 *   transcript — replay one of them into the Agent tab
 *   send       — resume it (or start a fresh one when sessionId is null) and append a user turn
 * Wire types live in @canopy/shared so the UI renders exactly what the daemon emits.
 */
import type {
  AgentCapabilities,
  AgentProvider,
  AgentSessionSummary,
  AgentStreamEvent,
  LiveControlsInput,
  PermissionDecisionInput,
  TranscriptResponse,
  TurnImage,
  TurnOptions
} from '@canopy/shared'

export type { AgentCapabilities, AgentProvider, AgentSessionSummary, AgentStreamEvent, TranscriptResponse }

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
  /**
   * Answers a `permission_requested` event a live turn is parked on. The answer arrives on its own
   * HTTP request, not on the turn's stream, so it is routed back by session id. False means nothing
   * was waiting under that request id. Providers that never park on a prompt leave this undefined.
   */
  answerPermission?(sessionId: string, input: PermissionDecisionInput): boolean
  /**
   * Everything a session in this checkout can do — commands, skills, subagents, models, MCP
   * servers, hooks. Read lazily (never at boot) and cached by the adapter; `refresh` bypasses that
   * cache. Providers that advertise nothing leave this undefined and the route 404s.
   */
  capabilities?(cwd: string, opts?: { sessionId?: string; refresh?: boolean }): Promise<AgentCapabilities>
  /** Stops the turn running in this session. True when a turn was running and got interrupted. */
  interrupt?(sessionId: string): Promise<boolean>
  /** Hands a prompt to the running turn. True when a turn was running and took the prompt. */
  queue?(sessionId: string, text: string, images?: Array<Omit<TurnImage, 'label'>>): boolean
  /** Retunes the running turn. True when a turn was running and the knobs were applied. */
  control?(sessionId: string, input: LiveControlsInput): Promise<boolean>
}
