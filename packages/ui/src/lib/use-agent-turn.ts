import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useReducer, useRef } from 'react'

import type { AgentProvider, AgentStreamEvent, PermissionDecisionInput, ReviewRequest, SessionRef, TranscriptResponse, TurnAttachment, TurnImage, TurnOptions } from '@canopy/shared'
import type { AgentEvent, AgentEventPayload } from '@canopy/shared/agent-stream'

import type { Activity } from '../components/agent/activity-orb'

import { useApi } from '../providers/api'
import { keys } from './query-keys'

/** Where a review goes: an existing session, or (`sessionId: null`) a new one the daemon creates. */
export type ReviewTarget = Pick<ReviewRequest, 'provider' | 'sessionId'>

/** The local pending prompt, shown until the daemon echoes it back as a `user_message` event. */
export interface PendingPrompt {
  text: string
  display: string
  attachments: TurnAttachment[]
  images: TurnImage[]
}

export interface TurnState {
  /** Events produced during this browser session (appended after the replayed log). */
  events: AgentEvent[]
  /** Written paths by `callId` from this turn's `files` frames. */
  filesByCall: Record<string, string[]>
  /** Images a user turn carried, by the echoed `user_message` event id. */
  extras: Record<string, { images: TurnImage[] }>
  /** The turn just sent, until its echo arrives; rendered so the user sees it immediately. */
  pending: PendingPrompt | null
  /** Assistant text still arriving as deltas, ahead of the committed block. */
  streamingText: string
  busy: boolean
  /** What the agent is doing while busy; drives the orb. */
  activity: Activity | null
  /** When the running turn began, for the elapsed-time readout. */
  startedAt: number | null
  /** Output tokens produced so far this turn. */
  tokens: number
  /** The session the last turn ran in — for a new session, the id the agent assigned. */
  sessionId: string | null
  error: string | null
}

type Action =
  | { type: 'reset' }
  | { type: 'start'; pending: PendingPrompt }
  | { type: 'event'; event: AgentStreamEvent }
  | { type: 'finish'; error?: string }

export const initialTurnState: TurnState = {
  events: [],
  filesByCall: {},
  extras: {},
  pending: null,
  streamingText: '',
  busy: false,
  activity: null,
  startedAt: null,
  tokens: 0,
  sessionId: null,
  error: null
}

/** The orb state a payload implies, or undefined to leave it unchanged. */
function activityFor(payload: AgentEventPayload): Activity | undefined {
  switch (payload.type) {
    case 'reasoning':
    case 'thinking_progress':
      return 'thinking'
    case 'delta':
      return payload.delta === 'text' ? 'solving' : payload.delta === 'block_start' && payload.blockType === 'thinking' ? 'thinking' : undefined
    case 'assistant_text':
    case 'tool_call_started':
    case 'task_started':
      return 'working'
    default:
      return undefined
  }
}

export function onEvent(state: TurnState, event: AgentStreamEvent): TurnState {
  if (event.type === 'session') return { ...state, sessionId: event.sessionId }
  if (event.type === 'progress') return { ...state, tokens: event.tokens }
  if (event.type === 'files') return { ...state, filesByCall: { ...state.filesByCall, [event.callId]: event.files } }
  if (event.type === 'done') return { ...state, streamingText: '', activity: null }
  if (event.type === 'error') return { ...state, streamingText: '', activity: null, error: event.message }
  if (event.type !== 'event') return state // exhaustive: every other arm is handled above

  const payload = event.event.payload
  const next: TurnState = { ...state, events: [...state.events, event.event] }
  if (payload.type === 'delta' && payload.delta === 'text') next.streamingText = state.streamingText + payload.text
  if (payload.type === 'assistant_text') next.streamingText = ''
  const activity = activityFor(payload)
  if (activity) next.activity = activity
  // The daemon's echo of the prompt we just sent: fold its images onto that event and stop showing
  // the local pending copy.
  if (payload.type === 'user_message' && !payload.synthetic && event.event.agentPath.length === 0 && state.pending) {
    if (state.pending.images.length > 0) next.extras = { ...state.extras, [event.event.id]: { images: state.pending.images } }
    next.pending = null
  }
  return next
}

function reducer(state: TurnState, action: Action): TurnState {
  switch (action.type) {
    case 'reset':
      return initialTurnState
    case 'start':
      return { ...initialTurnState, pending: action.pending, busy: true, activity: 'thinking', startedAt: Date.now() }
    case 'event':
      return onEvent(state, action.event)
    case 'finish':
      return { ...state, busy: false, activity: null, startedAt: null, error: action.error ?? state.error }
  }
}

/**
 * Drives one agent session from the UI: free-text messages and review bundles both go through
 * `run`, which shows the prompt immediately and streams the reply as agent-stream events. With no
 * `ref` and a `fresh` provider, the first message starts a new session.
 */
export function useAgentTurn(worktreeId: string, ref: SessionRef | undefined, fresh: AgentProvider | undefined, cwd: string, options: TurnOptions) {
  const api = useApi()
  const queryClient = useQueryClient()
  const [state, dispatch] = useReducer(reducer, initialTurnState)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => () => abortRef.current?.abort(), [])

  // A different session is a different conversation: drop this one's local turn.
  useEffect(() => {
    abortRef.current?.abort()
    dispatch({ type: 'reset' })
  }, [ref?.provider, ref?.sessionId])

  /** `startSeq` continues the numbering of the transcript the client already holds for `target`. */
  const nextSeqFor = useCallback(
    (target: SessionRef | undefined): number =>
      target ? (queryClient.getQueryData<TranscriptResponse>(keys.transcript(target))?.nextSeq ?? 0) : 0,
    [queryClient]
  )

  const run = useCallback(
    async (pending: PendingPrompt, stream: (signal: AbortSignal) => AsyncIterable<AgentStreamEvent>) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      dispatch({ type: 'start', pending })
      try {
        for await (const event of stream(controller.signal)) dispatch({ type: 'event', event })
        dispatch({ type: 'finish' })
        // The session file now holds this exchange; re-read it and drop the local copy so the
        // transcript stays the single source and nothing renders twice.
        if (ref) {
          await queryClient.invalidateQueries({ queryKey: keys.transcript(ref) })
          dispatch({ type: 'reset' })
        }
      } catch (error) {
        if (!controller.signal.aborted) dispatch({ type: 'finish', error: error instanceof Error ? error.message : String(error) })
      } finally {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: keys.sessions(worktreeId) }),
          queryClient.invalidateQueries({ queryKey: keys.comments(worktreeId) })
        ])
      }
    },
    [queryClient, ref, worktreeId]
  )

  /** `text` is what the agent receives; `display`/`attachments`/`images` are how the turn is shown. */
  const sendMessage = useCallback(
    (text: string, shown?: { display: string; attachments: TurnAttachment[]; images: TurnImage[] }) => {
      const pending: PendingPrompt = { text, display: shown?.display ?? text, attachments: shown?.attachments ?? [], images: shown?.images ?? [] }
      const images = shown?.images.map(({ mediaType, data }) => ({ mediaType, data }))
      const input = { ...options, text, startSeq: nextSeqFor(ref), ...(images?.length ? { images } : {}) }
      if (ref) return run(pending, (signal) => api.streamMessage(ref, { ...input, cwd }, signal))
      if (fresh) return run(pending, (signal) => api.streamNewSession(worktreeId, { ...input, provider: fresh, startSeq: 0 }, signal))
      return Promise.resolve()
    },
    [api, options, cwd, fresh, ref, run, worktreeId, nextSeqFor]
  )

  /** Reviews name their destination explicitly: any existing session, or `sessionId: null` for a new one. */
  const sendReview = useCallback(
    (target: ReviewTarget, request: Omit<ReviewRequest, 'provider' | 'sessionId'>, summary: string) => {
      const startSeq = target.sessionId ? nextSeqFor({ provider: target.provider, sessionId: target.sessionId }) : 0
      return run({ text: summary, display: summary, attachments: [], images: [] }, (signal) =>
        api.streamReview(worktreeId, { ...options, ...request, ...target, startSeq }, signal)
      )
    },
    [api, options, run, worktreeId, nextSeqFor]
  )

  /** Ends the running turn: closing the stream is what makes the daemon abort the agent. */
  const stop = useCallback((): void => {
    if (!abortRef.current || abortRef.current.signal.aborted) return
    abortRef.current.abort()
    dispatch({ type: 'finish' })
    // Whatever the agent got done before the stop is in the session file now.
    if (ref) void queryClient.invalidateQueries({ queryKey: keys.transcript(ref) })
  }, [queryClient, ref])

  /**
   * Answers a `permission_requested` ask of the running turn. A new session has no `ref` yet, but
   * its id arrived in the `session` frame before the agent could ask anything.
   */
  const answerPermission = useCallback(
    (input: PermissionDecisionInput): Promise<void> => {
      const target = ref ?? (fresh && state.sessionId ? { provider: fresh, sessionId: state.sessionId } : undefined)
      if (!target) return Promise.resolve()
      return api.answerPermission(target, input).catch((error: unknown) => {
        dispatch({ type: 'finish', error: error instanceof Error ? error.message : String(error) })
      })
    },
    [api, fresh, ref, state.sessionId]
  )

  return { ...state, sendMessage, sendReview, answerPermission, stop }
}

export type AgentTurn = ReturnType<typeof useAgentTurn>
