import type { PermissionDecisionInput } from '@canopy/shared'

/**
 * The parked "may I run this tool?" asks of every live turn.
 *
 * The SDK asks through a callback it then blocks on, but the answer arrives over a different
 * connection entirely — an HTTP POST from whichever client is watching the turn's SSE stream. The
 * desk is the join between the two: the adapter parks a promise here under the turn's session id,
 * the route resolves it by the same id, and nothing in either path has to know about the other.
 *
 * Keyed by session *and* request so two worktrees prompting at once can't answer each other, and
 * so a stale answer for a finished turn is a miss (`answer` returns false) rather than a crash.
 */
export class PermissionDesk {
  private readonly parked = new Map<string, (decision: PermissionDecisionInput) => void>()

  private static key(sessionId: string, requestId: string): string {
    return `${sessionId}:${requestId}`
  }

  /**
   * Parks until the request is answered. An abort settles it as a deny rather than a rejection:
   * the caller owes the SDK a `PermissionResult` either way, and a rejection there would strand
   * the tool call — the SDK has no deadline of its own on a permission prompt.
   */
  ask(sessionId: string, requestId: string, signal?: AbortSignal): Promise<PermissionDecisionInput> {
    const key = PermissionDesk.key(sessionId, requestId)
    return new Promise((resolve) => {
      const settle = (decision: PermissionDecisionInput): void => {
        if (!this.parked.delete(key)) return
        signal?.removeEventListener('abort', onAbort)
        resolve(decision)
      }
      const onAbort = (): void => settle({ requestId, behavior: 'deny' })

      this.parked.set(key, settle)
      if (signal?.aborted) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** False when nothing is parked under that id — the turn ended, or the answer is a duplicate. */
  answer(sessionId: string, input: PermissionDecisionInput): boolean {
    const settle = this.parked.get(PermissionDesk.key(sessionId, input.requestId))
    if (!settle) return false
    settle(input)
    return true
  }

  /** Request ids still waiting on this session. */
  pending(sessionId: string): string[] {
    const prefix = `${sessionId}:`
    return [...this.parked.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length))
  }
}

export const createPermissionDesk = (): PermissionDesk => new PermissionDesk()
