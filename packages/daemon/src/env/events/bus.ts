/**
 * The daemon's single event fan-out. Every mutation the UI cares about becomes one
 * `CanopyEvent` with a monotonic `seq`; a ring buffer lets a client that dropped its SSE
 * connection resume with `?since=` instead of refetching the world. When the gap is wider
 * than the buffer, `replay` says so (null) and the route answers with a `reset`.
 */
import type { CanopyEvent } from '@canopy/shared'

import type { CanopyEventInput, EventBus } from '../types'

/**
 * @param bufferSize how many events stay replayable; 2000 covers a few minutes of a busy
 *   daemon, which is longer than any realistic reconnect.
 */
export function createEventBus(bufferSize = 2000): EventBus {
  const buffer: CanopyEvent[] = []
  const listeners = new Set<(event: CanopyEvent) => void>()
  let seq = 0

  return {
    emit(input: CanopyEventInput): CanopyEvent {
      seq += 1
      const event = { ...input, seq } as CanopyEvent
      buffer.push(event)
      if (buffer.length > bufferSize) buffer.splice(0, buffer.length - bufferSize)
      for (const listener of listeners) {
        // One broken subscriber (a closed SSE socket mid-write) must not stop the others.
        try {
          listener(event)
        } catch (error) {
          console.error('[events] listener failed:', error)
        }
      }
      return event
    },

    replay(since: number): CanopyEvent[] | null {
      if (since >= seq) return []
      const oldest = buffer[0]
      // No gap only when the buffer still holds the very next event the client is missing.
      if (!oldest || oldest.seq > since + 1) return null
      return buffer.filter((event) => event.seq > since)
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    get seq() {
      return seq
    }
  }
}
