import type { AgentStreamEvent } from '@canopy/shared'

import type { AgentAdapter, AgentSessionSummary, SendOptions, Transcript } from '../../src/agents/types'

/** Scripted adapter: whatever `script` returns is streamed; every send is recorded. */
export class FakeAgent implements AgentAdapter {
  readonly provider = 'claude' as const
  readonly sent: Array<{ sessionId: string | null; text: string; options?: SendOptions }> = []
  /** Whether the HTTP layer had already aborted us one tick into the turn. */
  abortedEarly: boolean | undefined
  sessions: AgentSessionSummary[] = [{ provider: 'claude', sessionId: 's1', title: 'fixture session', updatedAt: 1 }]
  script: (text: string) => AgentStreamEvent[] = (text) => [
    { type: 'session', provider: 'claude', sessionId: 's1' },
    { type: 'delta', text: `ack: ${text.length} chars` },
    { type: 'done', sessionId: 's1' }
  ]

  available = async (): Promise<boolean> => true
  listSessions = async (): Promise<AgentSessionSummary[]> => this.sessions
  transcript = async (): Promise<Transcript> => ({ items: [{ id: 't1', role: 'user', text: 'hello' }], model: 'claude-opus-5', effort: 'medium' })

  async *send(sessionId: string | null, text: string, options?: SendOptions): AsyncIterable<AgentStreamEvent> {
    this.sent.push({ sessionId, text, options })
    // A null id asks for a new session: the fake mints one, the way the real adapters report theirs.
    const [first, ...rest] = this.script(text).map((event) =>
      sessionId === null && (event.type === 'session' || event.type === 'done') ? { ...event, sessionId: 's-new' } : event
    )
    if (first) yield first
    await new Promise((resolve) => setTimeout(resolve, 20))
    this.abortedEarly = options?.signal?.aborted
    yield* rest
  }
}
