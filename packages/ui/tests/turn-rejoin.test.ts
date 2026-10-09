import { describe, expect, it } from 'vitest'

import type { AgentEvent } from '@canopy/shared/agent-stream'

import { replayBefore } from '../src/lib/use-transcript-model'

const at = (seq: number): AgentEvent => ({ id: `s:${seq}`, sessionId: 's', seq, ts: null, agentPath: [], payload: { type: 'assistant_text', text: `${seq}`, block: null }, raw: null })

describe('replayBefore', () => {
  it('drops the part of a mid-turn replay that the rejoined live turn repeats', () => {
    const replay = [at(0), at(1), at(2), at(3)]
    expect(replayBefore(replay, 2).map((event) => event.seq)).toEqual([0, 1])
  })

  it('keeps the whole replay while nothing is live', () => {
    expect(replayBefore([at(0), at(1)], undefined)).toHaveLength(2)
  })
})
