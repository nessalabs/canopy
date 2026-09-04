import { describe, expect, it } from 'vitest'

import { AgentEventType, ClaudeStreamMapper, isEvent } from '@canopy/shared/agent-stream'

import { mapClaudeMessage } from '../src/agents/claude-map'
import { isBookkeeping, normalizeUserMessage } from '../src/agents/claude-normalize'

const userLine = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'user' as const,
  uuid: 'u1',
  session_id: 's1',
  parent_tool_use_id: null,
  message: { role: 'user', content },
  ...extra
})

let uuidSeq = 0
const assistantLine = (blocks: unknown[]) => ({
  type: 'assistant' as const,
  // Distinct per call: the mapper dedupes by uuid, so a repeat would map to nothing.
  uuid: `a${uuidSeq++}`,
  session_id: 's1',
  parent_tool_use_id: null,
  message: { role: 'assistant', content: blocks }
})

describe('normalizeUserMessage', () => {
  it('flags a bookkeeping-only string prompt so no turn opens', () => {
    expect(isBookkeeping('<system-reminder>be nice</system-reminder>')).toBe(true)
    const { line, images } = normalizeUserMessage(userLine('<system-reminder>be nice</system-reminder>'))
    expect(line.isSynthetic).toBe(true)
    expect(images).toEqual([])
  })

  it('keeps a plain string prompt as the human turn it is', () => {
    const { line } = normalizeUserMessage(userLine('fix the bug'))
    expect(line.isSynthetic).toBeUndefined()
    expect(line.message?.content).toBe('fix the bug')
  })

  it('strips bookkeeping and lifts images out of an array prompt, collapsing the rest to a string', () => {
    const { line, images } = normalizeUserMessage(
      userLine([
        { type: 'text', text: '<system-reminder>context</system-reminder>' },
        { type: 'text', text: 'look at [Image #1]' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }
      ])
    )
    expect(line.message?.content).toBe('look at [Image #1]')
    expect(images).toEqual([{ label: 'Image #1', mediaType: 'image/png', data: 'AAA' }])
  })

  it('leaves a tool_result line untouched — that is real array content, not a prompt', () => {
    const line = userLine([{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }])
    expect(normalizeUserMessage(line).line).toBe(line)
  })
})

describe('mapClaudeMessage', () => {
  it('maps an array prompt to one real user turn and hangs its images off that event', () => {
    const mapper = new ClaudeStreamMapper()
    const { events, extras } = mapClaudeMessage(
      mapper,
      userLine([
        { type: 'text', text: 'see [Image #1]' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }
      ])
    )
    const prompt = events.find((event) => isEvent(event, AgentEventType.UserMessage))
    expect(prompt && isEvent(prompt, AgentEventType.UserMessage) ? [prompt.payload.text, prompt.payload.synthetic] : null).toEqual(['see [Image #1]', false])
    expect(extras[prompt?.id ?? '']?.images).toHaveLength(1)
  })

  it('tags a file-writing tool call with the path it wrote, and not a read', () => {
    const mapper = new ClaudeStreamMapper()
    const edit = mapClaudeMessage(mapper, assistantLine([{ type: 'tool_use', id: 'c1', name: 'Edit', input: { file_path: '/wt/a.ts', old_string: 'x', new_string: 'y' } }]))
    expect(edit.files).toEqual({ c1: ['/wt/a.ts'] })
    const bash = mapClaudeMessage(mapper, assistantLine([{ type: 'tool_use', id: 'c2', name: 'Bash', input: { command: 'cat > src/x.ts <<EOF\nhi\nEOF' } }]), '/wt')
    expect(bash.files).toEqual({ c2: ['/wt/src/x.ts'] })
    const read = mapClaudeMessage(mapper, assistantLine([{ type: 'tool_use', id: 'c3', name: 'Read', input: { file_path: '/wt/a.ts' } }]))
    expect(read.files).toEqual({})
  })

  it('numbers events across messages from the mapper\'s startSeq', () => {
    const mapper = new ClaudeStreamMapper({ startSeq: 10 })
    const first = mapClaudeMessage(mapper, assistantLine([{ type: 'text', text: 'hi' }]))
    const second = mapClaudeMessage(mapper, assistantLine([{ type: 'text', text: 'there' }]))
    expect(first.events[0]?.seq).toBe(10)
    expect(second.events[0]?.seq).toBe(11)
    expect(second.events[0]?.id).toBe('s1:11')
  })
})
