import { describe, expect, it } from 'vitest'

import { parseSessionPanelId, sessionPanelId } from '../src/lib/session-panels'

describe('session panel ids', () => {
  it('round-trips a session, colons in its id included', () => {
    const ref = { provider: 'codex', sessionId: 'thread:abc-1' } as const
    expect(parseSessionPanelId(sessionPanelId(ref))).toEqual(ref)
  })

  it('names none of the fixed panels, nor a malformed or unknown-provider id', () => {
    for (const id of ['conversation', 'sessions', 'session:', 'session:claude:', 'session:gemini:x', 'session::x']) {
      expect(parseSessionPanelId(id)).toBeUndefined()
    }
  })
})
