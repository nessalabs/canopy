import { describe, expect, it } from 'vitest'

import { blocksOf, diffSegments } from '../src/lib/markdown-diff'

/** Builds a one-file unified patch from its hunks, the way git writes them. */
const patchOf = (...hunks: string[]): string => `diff --git a/doc.md b/doc.md\n--- a/doc.md\n+++ b/doc.md\n${hunks.join('\n')}\n`

describe('blocksOf', () => {
  it('cuts on blank lines and keeps the separator with the block above', () => {
    expect(blocksOf(['# Title', '', 'Prose.', ''])).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 4 }
    ])
  })

  it('keeps a fenced code block whole, blank lines and all', () => {
    const lines = ['```ts', 'const a = 1', '', 'const b = 2', '```', '', 'After.']
    expect(blocksOf(lines)).toEqual([
      { start: 1, end: 6 },
      { start: 7, end: 7 }
    ])
  })

  it('keeps a loose list together so its numbering survives', () => {
    expect(blocksOf(['1. one', '', '2. two', '', 'Prose.'])).toEqual([
      { start: 1, end: 4 },
      { start: 5, end: 5 }
    ])
  })
})

describe('diffSegments', () => {
  it('marks the block an addition falls in and leaves the rest as context', () => {
    const text = '# Title\n\nOld prose.\n\n## New\n\nNew prose.\n'
    const patch = patchOf('@@ -1,3 +1,7 @@', ' # Title', ' ', ' Old prose.', '+', '+## New', '+', '+New prose.')
    expect(diffSegments(text, patch)).toEqual([
      { kind: 'context', text: '# Title\n\nOld prose.\n', line: 1 },
      { kind: 'added', text: '## New\n\nNew prose.', line: 5 }
    ])
  })

  it('renders a deleted block where it stood', () => {
    const text = '# Title\n\nKept.\n'
    const patch = patchOf('@@ -1,5 +1,3 @@', ' # Title', ' ', '-Cut prose.', '-', ' Kept.')
    expect(diffSegments(text, patch)).toEqual([
      { kind: 'context', text: '# Title\n', line: 1 },
      { kind: 'removed', text: 'Cut prose.\n', line: 3 },
      { kind: 'context', text: 'Kept.', line: 3 }
    ])
  })

  it('marks a paragraph a single reworded line falls in, whole', () => {
    const text = 'One.\nTwo changed.\nThree.\n'
    const patch = patchOf('@@ -1,3 +1,3 @@', ' One.', '-Two.', '+Two changed.', ' Three.')
    expect(diffSegments(text, patch)).toEqual([
      { kind: 'removed', text: 'Two.', line: 2 },
      { kind: 'added', text: 'One.\nTwo changed.\nThree.', line: 1 }
    ])
  })

  it('takes a whole new file as one added run', () => {
    const text = '# New\n\nBody.\n'
    const patch = patchOf('@@ -0,0 +1,3 @@', '+# New', '+', '+Body.')
    expect(diffSegments(text, patch)).toEqual([{ kind: 'added', text: '# New\n\nBody.', line: 1 }])
  })

  it('places a deletion past the end of the new file at the end', () => {
    const text = 'Kept.\n'
    const patch = patchOf('@@ -1,3 +1,1 @@', ' Kept.', '-', '-Tail.')
    expect(diffSegments(text, patch)).toEqual([
      { kind: 'context', text: 'Kept.', line: 1 },
      { kind: 'removed', text: '\nTail.', line: 2 }
    ])
  })
})
