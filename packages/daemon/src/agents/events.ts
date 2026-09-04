import type { AgentEvent } from '@canopy/shared/agent-stream'

/**
 * Drops the `raw` source line an event carries before it goes over the wire or into a replay.
 *
 * The mapper keeps the whole originating line on every event it derives from it, so one assistant
 * message with three tool calls repeats that line four times. Canopy renders from the payload alone,
 * so `raw` is pure weight — worst on replay, where every event ships it at once.
 */
export function slim(event: AgentEvent): AgentEvent {
  return event.raw === null ? event : { ...event, raw: null }
}
