import { describe, expect, it } from 'vitest'

import { lastAssistantEffort, queuedPrompts, sessionFilePath } from '../src/agents/claude-session'
import { imagesFromBlocks } from '../src/agents/images'

describe('claude session file', () => {
  it('maps a cwd to Claude Code\'s project directory', () => {
    expect(sessionFilePath('/home/me/i/akd-labs', 'abc')).toMatch(/\/\.claude\/projects\/-home-me-i-akd-labs\/abc\.jsonl$/)
  })
  it('reads the effort of the last assistant entry, skipping noise', () => {
    const jsonl = [
      JSON.stringify({ type: 'assistant', effort: 'low', message: {} }),
      JSON.stringify({ type: 'user', message: {} }),
      JSON.stringify({ type: 'assistant', effort: 'high', message: {} }),
      '{"type":"assistant", broken',
      JSON.stringify({ type: 'mode', mode: 'normal' })
    ].join('\n')
    expect(lastAssistantEffort(jsonl)).toBe('high')
    expect(lastAssistantEffort('')).toBeUndefined()
  })

  it('recovers prompts typed mid-turn from queued_command attachments', () => {
    const jsonl = [
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'stop that' }),
      JSON.stringify({ type: 'attachment', uuid: 'a1', parentUuid: 'p1', attachment: { type: 'queued_command', prompt: 'stop that' } }),
      JSON.stringify({ type: 'attachment', uuid: 'a2', parentUuid: 'p2', attachment: { type: 'total_tokens_reminder', text: 'x' } })
    ].join('\n')
    expect(queuedPrompts(jsonl)).toEqual([{ uuid: 'a1', parentUuid: 'p1', prompt: 'stop that' }])
  })

  it('pairs image blocks with their [Image #N] placeholders', () => {
    const blocks = [
      { type: 'text' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBB' } },
      { type: 'image', source: { type: 'url', url: 'https://x' } }
    ]
    expect(imagesFromBlocks(blocks, 'see [Image #13] and then [Image #14]')).toEqual([
      { label: 'Image #13', mediaType: 'image/png', data: 'AAA' },
      { label: 'Image #14', mediaType: 'image/jpeg', data: 'BBB' }
    ])
    expect(imagesFromBlocks(blocks.slice(0, 2), 'no placeholder')[0]?.label).toBe('Image 1')
  })
})
