import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useReducer, useRef } from 'react'

import type { AgentProvider, AgentStreamEvent, LiveControlsInput, PermissionDecisionInput, ReviewRequest, SessionRef, TranscriptResponse, TurnAttachment, TurnExtras, TurnImage, TurnOptions } from '@canopy/shared'
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

/** What the turn cost, as the daemon reports it after the agent's result. */
export type TurnUsage = Omit<Extract<AgentStreamEvent, { type: 'usage' }>, 'type'>

export interface TurnState {
  /** Events produced during this browser session (appended after the replayed log). */
  events: AgentEvent[]
  /** Written paths by `callId` from this turn's `files` frames. */
  filesByCall: Record<string, string[]>
  /** Canopy-only data by event id: the images a user turn carried and the provider's id for it. */
  extras: Record<string, TurnExtras>
  /** The turn just sent, until its echo arrives; rendered so the user sees it immediately. */
  pending: PendingPrompt | null
  /** Prompts typed into the running turn, until the agent echoes each as a `user_message`. */
  queued: PendingPrompt[]
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
  /** What the last finished turn cost; outlives the turn so the summary line can render. */
  usage: TurnUsage | null
  error: string | null
}

type Action =
  | { type: 'reset' }
  /** Everything this turn held is in the session file now — keep only what still has to be shown. */
  | { type: 'settle' }
  | { type: 'start'; pending: PendingPrompt }
  | { type: 'queue'; pending: PendingPrompt }
  | { type: 'unqueue'; pending: PendingPrompt; error?: string }
  | { type: 'event'; event: AgentStreamEvent }
  | { type: 'finish'; error?: string }

export const initialTurnState: TurnState = {
  events: [],
  filesByCall: {},
  extras: {},
  pending: null,
  queued: [],
  streamingText: '',
  busy: false,
  activity: null,
  startedAt: null,
  tokens: 0,
  sessionId: null,
  usage: null,
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
  if (event.type === 'usage') {
    const { type: _type, ...usage } = event
    return { ...state, usage }
  }
  // The provider's own id for a prompt of this turn — what a file rewind is addressed by. Merged,
  // never assigned: the echo may already have hung the turn's images off the same event.
  if (event.type === 'message_id') {
    return { ...state, extras: { ...state.extras, [event.eventId]: { ...state.extras[event.eventId], messageId: event.messageId } } }
  }
  if (event.type === 'done') return { ...state, streamingText: '', activity: null }
  if (event.type === 'error') return { ...state, streamingText: '', activity: null, error: event.message }
  if (event.type !== 'event') return state // exhaustive: every other arm is handled above

  const payload = event.event.payload
  const next: TurnState = { ...state, events: [...state.events, event.event] }
  if (payload.type === 'delta' && payload.delta === 'text') next.streamingText = state.streamingText + payload.text
  if (payload.type === 'assistant_text') next.streamingText = ''
  const activity = activityFor(payload)
  if (activity) next.activity = activity
  // The daemon's echo of a prompt we sent: fold its images onto that event and stop showing the
  // local copy — the one just sent, else the oldest one the running turn had queued.
  if (payload.type === 'user_message' && !payload.synthetic && event.event.agentPath.length === 0) {
    const local = state.pending ?? state.queued[0]
    if (local) {
      if (local.images.length > 0) {
        next.extras = { ...state.extras, [event.event.id]: { ...state.extras[event.event.id], images: local.images } }
      }
      if (state.pending) next.pending = null
      else next.queued = state.queued.slice(1)
    }
  }
  return next
}

function reducer(state: TurnState, action: Action): TurnState {
  switch (action.type) {
    case 'reset':
      return initialTurnState
    case 'settle':
      // The transcript re-read holds the conversation now; only the cost of what just ran is ours.
      return { ...initialTurnState, usage: state.usage }
    case 'start':
      return { ...initialTurnState, pending: action.pending, busy: true, activity: 'thinking', startedAt: Date.now() }
    case 'queue':
      return { ...state, queued: [...state.queued, action.pending] }
    case 'unqueue':
      return { ...state, queued: state.queued.filter((prompt) => prompt !== action.pending), error: action.error ?? state.error }
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
          dispatch({ type: 'settle' })
        }
      } catch (error) {
        if (!controller.signal.aborted) dispatch({ type: 'finish', error: error instanceof Error ? error.message : String(error) })
      } finally {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: keys.sessions(worktreeId) }),
          queryClient.invalidateQueries({ queryKey: keys.comments(worktreeId) }),
          // The turn just advertised its own commands, skills and models; that beats a stale probe.
          queryClient.invalidateQueries({ queryKey: keys.capabilitiesOf(worktreeId) })
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

  /**
   * The session a control request goes to. A new session has no `ref` yet, but its id arrived in
   * the `session` frame before the agent could ask, queue or be interrupted.
   */
  const target = ref ?? (fresh && state.sessionId ? { provider: fresh, sessionId: state.sessionId } : undefined)

  /** Drops the stream, which is what makes the daemon abort an agent no interrupt could reach. */
  const abort = useCallback((): void => {
    if (!abortRef.current || abortRef.current.signal.aborted) return
    abortRef.current.abort()
    dispatch({ type: 'finish' })
    // Whatever the agent got done before the stop is in the session file now.
    if (ref) void queryClient.invalidateQueries({ queryKey: keys.transcript(ref) })
  }, [queryClient, ref])

  /**
   * Ends the running turn. An interrupt is the clean stop — the agent stops where it is and still
   * reports what it got done, so the turn keeps streaming until the daemon's `done` and `busy`
   * stays true until then. With no live turn to interrupt (404) or no daemon to ask, the stream
   * is dropped instead.
   */
  const stop = useCallback((): void => {
    if (!target) {
      abort()
      return
    }
    void api.interruptTurn(target).catch(() => abort())
  }, [abort, api, target?.provider, target?.sessionId])

  /**
   * A prompt typed while the agent works: the daemon folds it into the running turn. Shown as a
   * pending bubble straight away, and taken back down if the daemon says nothing is running.
   */
  const queueMessage = useCallback(
    (text: string, shown?: { display: string; attachments: TurnAttachment[]; images: TurnImage[] }): Promise<void> => {
      const pending: PendingPrompt = { text, display: shown?.display ?? text, attachments: shown?.attachments ?? [], images: shown?.images ?? [] }
      const images = shown?.images.map(({ mediaType, data }) => ({ mediaType, data }))
      dispatch({ type: 'queue', pending })
      // A brand-new session has no id to queue against until the agent names it.
      if (!target) {
        dispatch({ type: 'unqueue', pending, error: 'There is no running turn to queue this into yet.' })
        return Promise.resolve()
      }
      return api.queueMessage(target, { text, ...(images?.length ? { images } : {}) }).catch((error: unknown) => {
        dispatch({ type: 'unqueue', pending, error: error instanceof Error ? error.message : String(error) })
      })
    },
    [api, target?.provider, target?.sessionId]
  )

  /** Model or access mode for the running turn, from its next model call on. Nothing running: nothing to do. */
  const setLiveControls = useCallback(
    (input: LiveControlsInput): Promise<void> => {
      if (!target) return Promise.resolve()
      return api.updateLiveControls(target, input).catch(() => {})
    },
    [api, target?.provider, target?.sessionId]
  )

  /** Answers a `permission_requested` ask of the running turn. */
  const answerPermission = useCallback(
    (input: PermissionDecisionInput): Promise<void> => {
      if (!target) return Promise.resolve()
      return api.answerPermission(target, input).catch((error: unknown) => {
        dispatch({ type: 'finish', error: error instanceof Error ? error.message : String(error) })
      })
    },
    [api, target?.provider, target?.sessionId]
  )

  return { ...state, sendMessage, sendReview, queueMessage, answerPermission, setLiveControls, stop }
}

export type AgentTurn = ReturnType<typeof useAgentTurn>
