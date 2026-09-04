/** @responsibility Emits normalized events in order, holding the small amount of state that requires. */

import type { AgentEvent, AgentEventPayload, AgentPath } from "./events"
import type { JsonValue } from "./json"

/**
 * The bookkeeping every mapper needs, and nothing else.
 *
 * Every wire has to do the same four things: number its events, remember which
 * session a frame belongs to, announce a session once, and give a streamed
 * chunk a block to be superseded on. Written once because a second copy is a
 * second place for the ordering to drift.
 *
 * Deliberately knows nothing about any wire's field names — a caller reads its
 * own frame and passes ids in.
 */
export class EventSink {
  private seq: number
  /** The session a line belongs to, so every event is stamped with its own. */
  current: string | null = null
  /** The first session seen, which is what a single-session consumer means by "the" session. */
  primary: string | null = null
  /** Sessions already announced. The server's bus carries more than one. */
  readonly openedSessions = new Set<string>()
  /**
   * Calls already opened, and already settled.
   *
   * A one-way stream publishes a call once; a bus republishes the same part at
   * every status it passes through. Without this the row opens three or four
   * times for one call, and a turn reports several times the tools it ran.
   */
  readonly openedCalls = new Set<string>()
  readonly settledCalls = new Set<string>()
  /**
   * Which index each streamed part holds in its message.
   *
   * The server identifies a block by a part id; a `BlockRef` identifies one by
   * position. Assigning positions in order of first appearance keeps a delta
   * joinable to the part that supersedes it, without widening the shared
   * contract for one provider's id scheme.
   */
  private readonly partIndex = new Map<string, number>()

  constructor(startSeq = 0) {
    this.seq = startSeq
  }

  /**
   * One event, numbered and stamped with the session it belongs to.
   *
   * `path` is where a wire that nests agents says so; most do not, and an
   * empty path is the main conversation. Taking it as an argument is what lets
   * a wire that *does* nest — Claude's subagents — use this rather than
   * keeping a fourth copy of the numbering.
   */
  build(payload: AgentEventPayload, raw: JsonValue, ts: string | null, path: AgentPath = []): AgentEvent {
    const seq = this.seq
    this.seq += 1
    const sessionId = this.current ?? this.primary ?? "unknown"
    return { id: `${sessionId}:${seq}`, sessionId, seq, ts, agentPath: path, payload, raw }
  }

  /** A part's position in its message, assigned in order of first appearance. */
  indexOf(messageId: string, partId: string): number {
    const key = `${messageId}:${partId}`
    const existing = this.partIndex.get(key)
    if (existing !== undefined) return existing
    let next = 0
    for (const stored of this.partIndex.keys()) if (stored.startsWith(`${messageId}:`)) next += 1
    this.partIndex.set(key, next)
    return next
  }

}
