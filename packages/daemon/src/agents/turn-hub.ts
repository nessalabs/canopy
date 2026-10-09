/**
 * Agent turns that outlive the page that started them.
 *
 * A turn used to be its HTTP response: the route iterated the adapter's events into the SSE
 * stream, and the stream closing — the user switching worktrees, a reload — aborted the agent
 * mid-task. Here a turn runs on its own, draining the adapter to the end, and keeps every event
 * it produced. Any number of clients follow it: each gets the events so far, then the live ones,
 * and leaving only stops that client following. Stopping the agent is the interrupt route's job.
 *
 * Events are kept for the turn's lifetime only; once it ends, the session file holds it all.
 */
import type { AgentProvider, AgentStreamEvent } from '@canopy/shared'

export class RunningTurn {
  readonly events: AgentStreamEvent[] = []
  private ended = false
  private readonly wakers = new Set<() => void>()

  constructor(
    readonly provider: AgentProvider,
    public sessionId: string | null
  ) {}

  get done(): boolean {
    return this.ended
  }

  push(event: AgentStreamEvent): void {
    this.events.push(event)
    this.wake()
  }

  end(): void {
    this.ended = true
    this.wake()
  }

  private wake(): void {
    const wakers = [...this.wakers]
    this.wakers.clear()
    for (const waker of wakers) waker()
  }

  /** Everything so far, then each new event, until the turn ends or `signal` (the follower leaving) fires. */
  async *follow(signal?: AbortSignal): AsyncGenerator<AgentStreamEvent> {
    let next = 0
    while (!signal?.aborted) {
      while (next < this.events.length) yield this.events[next++]!
      if (this.ended) return
      await new Promise<void>((resolve) => {
        const settle = (): void => {
          this.wakers.delete(settle)
          signal?.removeEventListener('abort', settle)
          resolve()
        }
        this.wakers.add(settle)
        signal?.addEventListener('abort', settle, { once: true })
      })
    }
  }
}

const keyOf = (provider: AgentProvider, sessionId: string): string => `${provider}:${sessionId}`

export class TurnHub {
  private readonly turns = new Map<string, RunningTurn>()

  /**
   * Runs `source` to the end in the background. A turn that opens a new session has no id until
   * its `session` event; from then on it can be found by it.
   */
  start(provider: AgentProvider, sessionId: string | null, source: AsyncIterable<AgentStreamEvent>): RunningTurn {
    const turn = new RunningTurn(provider, sessionId)
    if (sessionId) this.turns.set(keyOf(provider, sessionId), turn)
    void this.drain(turn, source)
    return turn
  }

  private async drain(turn: RunningTurn, source: AsyncIterable<AgentStreamEvent>): Promise<void> {
    try {
      for await (const event of source) {
        if (event.type === 'session' && turn.sessionId !== event.sessionId) {
          turn.sessionId = event.sessionId
          this.turns.set(keyOf(turn.provider, event.sessionId), turn)
        }
        turn.push(event)
      }
    } catch (error) {
      turn.push({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      turn.end()
      const key = turn.sessionId ? keyOf(turn.provider, turn.sessionId) : null
      // Never someone else's: a new turn on the same session may already be registered.
      if (key && this.turns.get(key) === turn) this.turns.delete(key)
    }
  }

  find(provider: AgentProvider, sessionId: string): RunningTurn | undefined {
    return this.turns.get(keyOf(provider, sessionId))
  }

  isRunning(provider: AgentProvider, sessionId: string): boolean {
    return this.turns.has(keyOf(provider, sessionId))
  }
}
