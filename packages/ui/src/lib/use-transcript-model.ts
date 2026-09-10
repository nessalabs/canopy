import { useMemo, useRef } from 'react'

import type { TranscriptResponse, TurnImage } from '@canopy/shared'
import type { DeltaBuffers, Transcript as FoldedTranscript } from '@canopy/shared/agent-stream'
import { TranscriptBuilder, applyDeltas } from '@canopy/shared/agent-stream'

import type { AgentTurn } from './use-agent-turn'

export interface TranscriptModel {
  transcript: FoldedTranscript
  /** Accumulated delta text by block, for streaming previews. */
  previews: DeltaBuffers
  /** Written paths by `callId`, replay plus this turn. */
  filesByCall: Record<string, string[]>
  /** Images by user-message event id, replay plus this turn. */
  extras: Record<string, { images: TurnImage[] }>
}

/** The fold in progress: which replay it started from and how much of the live turn it has absorbed. */
interface Fold {
  history: TranscriptResponse | undefined
  builder: TranscriptBuilder
  pushed: number
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
    // A new replay, or a live log that shrank (the turn was reset), starts the fold over.
    if (current === null || current.history !== history || current.pushed > turn.events.length) {
      const builder = new TranscriptBuilder()
      builder.push(history?.events ?? [])
      current = { history, builder, pushed: 0 }
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
  const filesByCall = useMemo(() => ({ ...(history?.files ?? {}), ...turn.filesByCall }), [history, turn.filesByCall])
  const extras = useMemo(() => ({ ...(history?.extras ?? {}), ...turn.extras }), [history, turn.extras])
  return { transcript, previews, filesByCall, extras }
}

