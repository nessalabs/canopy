import { describe, expect, it } from 'vitest'

import { parseRegistryEntry } from '../src/agents/claude-terminal'

describe('claude terminal registry', () => {
  it('accepts an interactive CLI entry and rejects everything else', () => {
    const entry = JSON.stringify({ pid: 42, sessionId: 's1', kind: 'interactive', entrypoint: 'cli', cwd: '/wt', messagingSocketPath: '/tmp/s.sock', status: 'idle' })
    expect(parseRegistryEntry(entry)).toEqual({ pid: 42, sessionId: 's1', socketPath: '/tmp/s.sock', cwd: '/wt', name: undefined, status: 'idle' })
    // Headless (SDK) sessions and malformed records are not terminal sessions.
    expect(parseRegistryEntry(JSON.stringify({ pid: 42, sessionId: 's1', kind: 'programmatic', entrypoint: 'sdk', messagingSocketPath: '/tmp/s.sock' }))).toBeUndefined()
    expect(parseRegistryEntry(JSON.stringify({ pid: 42, kind: 'interactive', entrypoint: 'cli' }))).toBeUndefined()
    expect(parseRegistryEntry('{ not json')).toBeUndefined()
  })
})
