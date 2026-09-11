import type { AgentStreamEvent, PermissionDecisionInput } from '@canopy/shared'
import type { AgentEvent } from '@canopy/shared/agent-stream'

import type { AgentAdapter, AgentSessionSummary, SendOptions, TranscriptResponse } from '../../src/agents/types'

/** A minimal agent-stream event, for scripting adapter output in tests. */
export const fakeEvent = (seq: number, payload: AgentEvent['payload'], sessionId = 's1'): AgentEvent => ({
  id: `${sessionId}:${seq}`,
  sessionId,
  seq,
  ts: null,
  agentPath: [],
  payload,
  raw: null
})

/** Scripted adapter: whatever `script` returns is streamed; every send is recorded. */
export class FakeAgent implements AgentAdapter {
  readonly provider = 'claude' as const
  readonly sent: Array<{ sessionId: string | null; text: string; options?: SendOptions }> = []
  /** Whether the HTTP layer had already aborted us one tick into the turn. */
  abortedEarly: boolean | undefined
  sessions: AgentSessionSummary[] = [{ provider: 'claude', sessionId: 's1', title: 'fixture session', updatedAt: 1 }]
  script: (text: string) => AgentStreamEvent[] = (text) => [
    { type: 'session', provider: 'claude', sessionId: 's1' },
    { type: 'event', event: fakeEvent(0, { type: 'assistant_text', text: `ack: ${text.length} chars`, block: null }) },
    { type: 'done', sessionId: 's1' }
  ]

  /** Permission answers the route handed us, and the one request id the fake claims to be parked on. */
  readonly answers: PermissionDecisionInput[] = []
  pendingRequestId = 'req-1'

  available = async (): Promise<boolean> => true
  listSessions = async (): Promise<AgentSessionSummary[]> => this.sessions
  /** Undefined, like a provider with no lookup, until a test gives the fake one. */
  describeSession: AgentAdapter['describeSession'] = undefined
  transcript = async (): Promise<TranscriptResponse> => ({
    events: [fakeEvent(0, { type: 'user_message', text: 'hello', synthetic: false })],
    files: {},
    extras: {},
    model: 'claude-opus-5',
    effort: 'medium',
    nextSeq: 1
  })

  answerPermission = (sessionId: string, input: PermissionDecisionInput): boolean => {
    this.answers.push(input)
    return sessionId !== '' && input.requestId === this.pendingRequestId
  }

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
