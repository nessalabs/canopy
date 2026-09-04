import { describe, expect, it } from 'vitest'

import { readSse } from '../src/client/sse'

const response = (...frames: string[]): Response => new Response(frames.map((f) => `data: ${f}\n\n`).join(''))

describe('readSse', () => {
  it('yields known events and skips ones this client does not understand', async () => {
    const events = []
    for await (const event of readSse(response('{"type":"delta","text":"hi"}', '{"type":"from-the-future"}', '{"type":"done","sessionId":"s"}'))) events.push(event)
    expect(events.map((e) => e.type)).toEqual(['delta', 'done'])
  })

  it('passes agent-stream events through by envelope, whatever their payload kind', async () => {
    const frame = (type: string) =>
      JSON.stringify({ type: 'event', event: { id: `s:1`, sessionId: 's', seq: 1, ts: null, agentPath: [], raw: null, payload: { type } } })
    const events = []
    for await (const event of readSse(response(frame('tool_call_started'), frame('unheard_of'), '{"type":"event","event":{"seq":1}}'))) events.push(event)
    expect(events.map((e) => (e.type === 'event' ? e.event.payload.type : e.type))).toEqual(['tool_call_started', 'unheard_of'])
  })
})
