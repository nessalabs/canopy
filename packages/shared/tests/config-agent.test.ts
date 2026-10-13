import { describe, expect, it } from 'vitest'

import type { AgentEvent } from '../src/agent-stream'
import { CONFIG_TOOLS, latestProposal, qualifiedConfigTool } from '../src/config-agent'

const event = (seq: number, payload: AgentEvent['payload'], agentPath: string[] = []): AgentEvent => ({ id: `e${seq}`, sessionId: 's', seq, ts: null, agentPath, payload, raw: null })
const result = (isError: boolean) => ({ text: '', isError, structured: null, images: [] })
const propose = qualifiedConfigTool(CONFIG_TOOLS.propose)

/** One propose call and its outcome. */
const call = (seq: number, callId: string, yaml: string, isError: boolean, agentPath: string[] = []) => [
  event(seq, { type: 'tool_call_started', callId, name: propose, kind: 'other', input: { yaml, summary: `try ${callId}` }, title: '' }, agentPath),
  event(seq + 1, { type: 'tool_call_completed', callId, result: result(isError) }, agentPath)
]

describe('latestProposal', () => {
  it('is the newest accepted proposal, skipping refused ones and subagents', () => {
    const events = [...call(0, 'c1', 'version: 1\n', false), ...call(2, 'c2', 'broken', true), ...call(4, 'c3', 'sub', false, ['task'])]
    expect(latestProposal(events)).toEqual({ callId: 'c1', yaml: 'version: 1\n', summary: 'try c1' })
  })

  it('waits for the call to finish before it counts', () => {
    expect(latestProposal(call(0, 'c1', 'version: 1\n', false).slice(0, 1))).toBeUndefined()
  })
})
