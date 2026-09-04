import { useMemo } from 'react'

import type { TranscriptResponse, TurnImage } from '@canopy/shared'
import type { AgentEvent, DeltaBuffers, Transcript as FoldedTranscript } from '@canopy/shared/agent-stream'
import { applyDeltas, buildTranscript } from '@canopy/shared/agent-stream'

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

/**
 * Folds the replayed event log and the live turn's events into one transcript. The replay is
 * numbered from 0 and the live turn from the replay's `nextSeq`, so concatenation is already in
 * order; `buildTranscript` sorts and dedupes defensively. Re-folding on each change is simple and
 * fast enough for a conversation; a very long session could move to an incremental `TranscriptBuilder`.
 */
export function useTranscriptModel(history: TranscriptResponse | undefined, turn: AgentTurn): TranscriptModel {
  const events = useMemo<AgentEvent[]>(() => [...(history?.events ?? []), ...turn.events], [history, turn.events])
  const transcript = useMemo(() => buildTranscript(events, { live: turn.busy }), [events, turn.busy])
  const previews = useMemo(() => applyDeltas(events), [events])
  const filesByCall = useMemo(() => ({ ...(history?.files ?? {}), ...turn.filesByCall }), [history, turn.filesByCall])
  const extras = useMemo(() => ({ ...(history?.extras ?? {}), ...turn.extras }), [history, turn.extras])
  return { transcript, previews, filesByCall, extras }
}
