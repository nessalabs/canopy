import { describe, expect, it } from 'vitest'

import { readSse } from '../src/client/sse'

const response = (...frames: string[]): Response => new Response(frames.map((f) => `data: ${f}\n\n`).join(''))

describe('readSse', () => {
  it('yields known events and skips ones this client does not understand', async () => {
    const events = []
    for await (const event of readSse(response('{"type":"delta","text":"hi"}', '{"type":"from-the-future"}', '{"type":"done","sessionId":"s"}'))) events.push(event)
    expect(events.map((e) => e.type)).toEqual(['delta', 'done'])
  })
})
