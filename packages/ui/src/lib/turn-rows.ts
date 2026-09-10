import type { AgentEvent, Transcript, Turn, WorkItem } from '@canopy/shared/agent-stream'
import { AgentEventType, isEvent, isToolGroup } from '@canopy/shared/agent-stream'

const seqOf = (item: WorkItem): number => (isToolGroup(item) ? (item.calls[0]?.seq ?? Number.POSITIVE_INFINITY) : item.seq)

/** Where a turn begins in the main-thread log: its prompt, else its first row. */
const startOf = (turn: Turn): number => turn.prompt?.seq ?? (turn.work[0] ? seqOf(turn.work[0]) : (turn.completed?.seq ?? Number.POSITIVE_INFINITY))

/** Puts `event` back among `work` at its place in the log. */
function reinsert(work: readonly WorkItem[], event: AgentEvent): readonly WorkItem[] {
  const at = work.findIndex((item) => seqOf(item) > event.seq)
  return at === -1 ? [...work, event] : [...work.slice(0, at), event, ...work.slice(at)]
}

/**
 * The rows each turn draws, by turn key.
 *
 * The fold lifts a turn's closing `assistant_text` out of `work` into `finalText`, for a view that
 * draws the answer as its own element and would otherwise print it twice. Canopy draws every
 * assistant message as the same bubble, so without this the last thing the agent said — for a
 * one-message reply, the whole reply — never renders. The lifted event is found again in the
 * main-thread log and put back at its `seq`, which also keeps a live turn's "let me look…" above
 * the tool calls that followed it instead of dangling below them until the next message lands.
 */
export function rowsByTurn(transcript: Transcript): ReadonlyMap<string, readonly WorkItem[]> {
  const rows = new Map<string, readonly WorkItem[]>()
  const { turns, events } = transcript
  let cursor = 0
  turns.forEach((turn, index) => {
    // A turn runs to its result, else to wherever the next one begins.
    const next = turns[index + 1]
    const end = turn.completed?.seq ?? (next ? startOf(next) : Number.POSITIVE_INFINITY)
    const final = turn.finalText?.trim() ?? null
    let lifted: AgentEvent | undefined
    for (; cursor < events.length && events[cursor]!.seq < end; cursor += 1) {
      const event = events[cursor]!
      if (final !== null && isEvent(event, AgentEventType.AssistantText) && event.payload.text.trim() === final) lifted = event
    }
    // The fold removes only the last match; an earlier identical message is still in `work`.
    const present = lifted !== undefined && turn.work.some((item) => !isToolGroup(item) && item.id === lifted.id)
    rows.set(turn.key, lifted === undefined || present ? turn.work : reinsert(turn.work, lifted))
  })
  return rows
}
