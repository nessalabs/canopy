import { useMemo, useRef } from 'react'

import type { TranscriptResponse, TurnExtras, TurnImage } from '@canopy/shared'
import type { AgentEvent, ContextUsage, DeltaBuffers, Transcript as FoldedTranscript } from '@canopy/shared/agent-stream'
import { TranscriptBuilder, applyDeltas, contextUsage } from '@canopy/shared/agent-stream'

import type { AgentTurn } from './use-agent-turn'

export interface TranscriptModel {
  transcript: FoldedTranscript
  /** Accumulated delta text by block, for streaming previews. */
  previews: DeltaBuffers
  /** Written paths by `callId`, replay plus this turn. */
  filesByCall: Record<string, string[]>
  /** Canopy-only data by event id — images and the provider's message id — replay plus this turn. */
  extras: Record<string, TurnExtras>
  /** How full the model's window is, as of the latest call the stream reported; null before any. */
  context: ContextUsage | null
}

/** The fold in progress: which replay it started from, where the live turn begins, and how much of it is absorbed. */
interface Fold {
  history: TranscriptResponse | undefined
  liveFrom: number | undefined
  builder: TranscriptBuilder
  pushed: number
}

/**
 * The replay up to where the live turn begins. The session file is written as the agent works, so
 * a replay read mid-turn — a rejoined turn, or a refetch while one streams — already holds the start
 * of the turn the live events are about to repeat. Both are numbered alike, so `seq` is the seam.
 */
export function replayBefore(events: AgentEvent[], liveFrom: number | undefined): AgentEvent[] {
  return liveFrom === undefined ? events : events.filter((event) => event.seq < liveFrom)
}

/**
 * Folds the replayed event log and the live turn's events into one transcript. The replay is
 * numbered from 0 and the live turn from the replay's `nextSeq`, so the live events simply extend
 * the log. The fold is incremental: a replay is absorbed once and each live event once, because a
 * streaming turn delivers dozens of deltas a second and refolding a long session for each of them
 * is what made the transcript stutter.
 */
export function useTranscriptModel(history: TranscriptResponse | undefined, turn: AgentTurn): TranscriptModel {
  const fold = useRef<Fold | null>(null)
  const transcript = useMemo(() => {
    let current = fold.current
    const liveFrom = turn.events[0]?.seq
    // A new replay, a live turn starting or reset, or a live log that shrank starts the fold over.
    if (current === null || current.history !== history || current.liveFrom !== liveFrom || current.pushed > turn.events.length) {
      const builder = new TranscriptBuilder()
      builder.push(replayBefore(history?.events ?? [], liveFrom))
      current = { history, liveFrom, builder, pushed: 0 }
      fold.current = current
    }
    if (current.pushed < turn.events.length) {
      current.builder.push(turn.events.slice(current.pushed))
      current.pushed = turn.events.length
    }
    return current.builder.snapshot({ live: turn.busy })
  }, [history, turn.events, turn.busy])
  // Only a live turn streams deltas; a replay stores committed blocks alone.
  const previews = useMemo(() => applyDeltas(turn.events), [turn.events])
  // Replay and live turn are folded separately, so a streaming turn re-walks its own events and
  // not the whole session; the live reading wins wherever it has one.
  const replayed = useMemo(() => contextUsage(history?.events ?? []), [history])
  const live = useMemo(() => contextUsage(turn.events), [turn.events])
  const context = useMemo<ContextUsage | null>(() => {
    if (!replayed && !live) return null
    return { tokens: live?.tokens ?? replayed?.tokens ?? null, window: live?.window ?? replayed?.window ?? null }
  }, [replayed, live])
  const filesByCall = useMemo(() => ({ ...(history?.files ?? {}), ...turn.filesByCall }), [history, turn.filesByCall])
  // Merged per event, not per map: the replay may know a message's provider id while the live turn
  // holds the images it was sent with, and an event needs both.
  const extras = useMemo(() => {
    const merged: Record<string, TurnExtras> = { ...(history?.extras ?? {}) }
    for (const [id, extra] of Object.entries(turn.extras)) merged[id] = { ...merged[id], ...extra }
    return merged
  }, [history, turn.extras])
  return { transcript, previews, filesByCall, extras, context }
}

