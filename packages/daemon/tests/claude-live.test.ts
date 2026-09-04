import { describe, expect, it } from 'vitest'

import { keyFileName, parseRegistryEntry, promptFrame } from '../src/agents/claude-live'
import { itemsFromLine } from '../src/agents/claude'

describe('live terminal sessions', () => {
  const entry = { pid: 42, sessionId: 's1', cwd: '/w', kind: 'interactive', entrypoint: 'cli', name: 'canopy-2f', status: 'busy', messagingSocketPath: '/run/user/1000/cc-socks/42.sock' }

  it('reads terminal sessions from the registry and ignores headless or broken records', () => {
    expect(parseRegistryEntry(JSON.stringify(entry))).toEqual({ pid: 42, sessionId: 's1', cwd: '/w', name: 'canopy-2f', status: 'busy', socketPath: '/run/user/1000/cc-socks/42.sock' })
    expect(parseRegistryEntry(JSON.stringify({ ...entry, entrypoint: 'sdk-ts' }))).toBeUndefined()
    expect(parseRegistryEntry(JSON.stringify({ ...entry, messagingSocketPath: undefined }))).toBeUndefined()
    expect(parseRegistryEntry('{not json')).toBeUndefined()
  })

  it("names the peer key the way Claude Code does: pid and sha256 of the socket path", () => {
    expect(keyFileName(42, '/run/user/1000/cc-socks/42.sock')).toMatch(/^42\.[0-9a-f]{64}\.key$/)
  })

  it('builds a queued user prompt frame', () => {
    expect(promptFrame('hi')).toMatchObject({ type: 'user', message: { role: 'user', content: 'hi' }, priority: 'next', from: 'canopy' })
  })

  it('turns appended session lines into items and skips bookkeeping', () => {
    const line = JSON.stringify({ type: 'assistant', uuid: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } })
    expect(itemsFromLine(line).map((i) => [i.role, i.text])).toEqual([['assistant', 'Done.']])
    expect(itemsFromLine(JSON.stringify({ type: 'last-prompt' }))).toEqual([])
  })
})
