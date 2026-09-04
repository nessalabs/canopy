import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useReducer, useRef } from 'react'

import type { AgentProvider, AgentStreamEvent, ReviewRequest, SessionRef, TranscriptItem, TurnAttachment, TurnImage, TurnOptions } from '@canopy/shared'

import type { Activity } from '../components/agent/activity-orb'

import { useApi } from '../providers/api'
import { keys } from './query-keys'

/** Where a review goes: an existing session, or (`sessionId: null`) a new one the daemon creates. */
export type ReviewTarget = Pick<ReviewRequest, 'provider' | 'sessionId'>

export interface TurnState {
  /** Items produced during this browser session (appended after the replayed transcript). */
  items: TranscriptItem[]
  /** Assistant text still arriving as deltas; folded into an item on `done`. */
  streamingText: string | null
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
  | { type: 'start'; user: TranscriptItem }
  | { type: 'event'; event: AgentStreamEvent }
  | { type: 'finish'; error?: string }

const initial: TurnState = { items: [], streamingText: null, busy: false, activity: null, startedAt: null, tokens: 0, sessionId: null, error: null }

const foldStreaming = (state: TurnState): TranscriptItem[] =>
  state.streamingText
    ? [...state.items, { id: `stream-${state.items.length}`, role: 'assistant', text: state.streamingText, at: Date.now() }]
    : state.items

/** Each event type maps to one state transition; no branching inside the reducer body. */
const ON_EVENT: { [K in AgentStreamEvent['type']]: (state: TurnState, event: Extract<AgentStreamEvent, { type: K }>) => TurnState } = {
  session: (state, event) => ({ ...state, sessionId: event.sessionId }),
  // Bridged in the agent-stream migration: folded by the transcript model once the UI reads events.
  event: (state) => state,
  files: (state) => state,
  delta: (state, event) => ({ ...state, streamingText: (state.streamingText ?? '') + event.text, activity: 'solving' }),
  item: (state, event) => ({
    ...state,
    items: [...foldStreaming(state), event.item],
    streamingText: null,
    activity: event.item.role === 'reasoning' ? 'thinking' : 'working'
  }),
  progress: (state, event) => ({ ...state, tokens: event.tokens }),
  done: (state) => ({ ...state, items: foldStreaming(state), streamingText: null, activity: null }),
  error: (state, event) => ({ ...state, items: foldStreaming(state), streamingText: null, activity: null, error: event.message })
}

function reducer(state: TurnState, action: Action): TurnState {
  switch (action.type) {
    case 'reset':
      return initial
    case 'start':
      return { ...state, items: [...state.items, action.user], busy: true, activity: 'thinking', startedAt: Date.now(), tokens: 0, error: null }
    case 'event':
      return (ON_EVENT[action.event.type] as (s: TurnState, e: AgentStreamEvent) => TurnState)(state, action.event)
    case 'finish':
      return { ...state, busy: false, activity: null, startedAt: null, error: action.error ?? state.error }
  }
}

/**
 * Drives one agent session from the UI: free-text messages and review bundles both
 * go through `run`, which appends the user turn locally and streams the reply.
 * With no `ref` and a `fresh` provider, the first message starts a new session.
 */
export function useAgentTurn(worktreeId: string, ref: SessionRef | undefined, fresh: AgentProvider | undefined, cwd: string, options: TurnOptions) {
  const api = useApi()
  const queryClient = useQueryClient()
  const [state, dispatch] = useReducer(reducer, initial)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => () => abortRef.current?.abort(), [])

  // A different session is a different conversation: drop this one's local turns.
  useEffect(() => {
    abortRef.current?.abort()
    dispatch({ type: 'reset' })
  }, [ref?.provider, ref?.sessionId])

  const run = useCallback(
    async (user: Omit<TranscriptItem, 'id' | 'role' | 'at'>, stream: (signal: AbortSignal) => AsyncIterable<AgentStreamEvent>) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      dispatch({ type: 'start', user: { ...user, id: `local-${Date.now()}`, role: 'user', at: Date.now() } })
      try {
        for await (const event of stream(controller.signal)) dispatch({ type: 'event', event })
        dispatch({ type: 'finish' })
        // The session file now holds this exchange; re-read it and drop the local copy so
        // the transcript stays the single source and nothing renders twice.
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

  /** `text` is what the agent receives; `display`/`attachments` are how the turn is shown. */
  const sendMessage = useCallback(
    (text: string, shown?: { display: string; attachments: TurnAttachment[]; images: TurnImage[] }) => {
      const images = shown?.images.map(({ mediaType, data }) => ({ mediaType, data }))
      const input = { ...options, text, ...(images?.length ? { images } : {}) }
      if (ref) return run({ text, ...shown }, (signal) => api.streamMessage(ref, { ...input, cwd }, signal))
      if (fresh) return run({ text, ...shown }, (signal) => api.streamNewSession(worktreeId, { ...input, provider: fresh }, signal))
      return Promise.resolve()
    },
    [api, options, cwd, fresh, ref, run, worktreeId]
  )

  /** Reviews name their destination explicitly: any existing session, or `sessionId: null` for a new one. */
  const sendReview = useCallback(
    (target: ReviewTarget, request: Omit<ReviewRequest, 'provider' | 'sessionId'>, summary: string) =>
      run({ text: summary }, (signal) => api.streamReview(worktreeId, { ...options, ...request, ...target }, signal)),
    [api, options, run, worktreeId]
  )

  return { ...state, sendMessage, sendReview }
}
