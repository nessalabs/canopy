import { describe, expect, it } from 'vitest'

import { previewMarkdown } from '../src/components/agent/attachment-preview'

describe('previewMarkdown', () => {
  it('renders a markdown file as itself', () => {
    expect(previewMarkdown({ label: 'plan.md', text: '# Plan' })).toBe('# Plan')
  })

  it('fences any other text in its extension’s language', () => {
    expect(previewMarkdown({ label: 'run.py', text: 'print(1)' })).toBe('```py\nprint(1)\n```')
  })

  it('fences longer than any backtick run inside, so the text cannot close it', () => {
    expect(previewMarkdown({ label: 'notes.txt', text: 'a ```` b' })).toBe('`````txt\na ```` b\n`````')
  })

  it('fences pasted text that has no extension', () => {
    expect(previewMarkdown({ label: 'Pasted text (2 lines)', text: 'x\ny' })).toBe('```\nx\ny\n```')
  })
})
