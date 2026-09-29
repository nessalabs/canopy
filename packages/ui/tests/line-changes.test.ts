import { describe, expect, it } from 'vitest'

import { lineChangesOf } from '../src/lib/line-changes'

/** Builds a one-file unified patch from its hunks, the way git writes them. */
const patchOf = (...hunks: string[]): string => `diff --git a/f.ts b/f.ts\n--- a/f.ts\n+++ b/f.ts\n${hunks.join('\n')}\n`

describe('lineChangesOf', () => {
  it('marks lines inserted between context as added', () => {
    expect(lineChangesOf(patchOf('@@ -1,2 +1,4 @@', ' a', '+b', '+c', ' d'))).toEqual([{ kind: 'added', start: 2, end: 3 }])
  })

  it('marks a deletion followed by as many additions as modified', () => {
    expect(lineChangesOf(patchOf('@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c'))).toEqual([{ kind: 'modified', start: 2, end: 2 }])
  })

  it('splits a rewrite that grew into modified lines, then added ones', () => {
    expect(lineChangesOf(patchOf('@@ -1,3 +1,5 @@', ' a', '-b', '+B', '+B2', '+B3', ' c'))).toEqual([
      { kind: 'modified', start: 2, end: 2 },
      { kind: 'added', start: 3, end: 4 }
    ])
  })

  it('marks a rewrite that shrank as modified only', () => {
    expect(lineChangesOf(patchOf('@@ -1,4 +1,3 @@', ' a', '-b', '-c', '+B', ' d'))).toEqual([{ kind: 'modified', start: 2, end: 2 }])
  })

  it('marks a pure deletion at the line that now follows it', () => {
    expect(lineChangesOf(patchOf('@@ -1,3 +1,2 @@', ' a', '-b', ' c'))).toEqual([{ kind: 'removed', start: 2, end: 2 }])
  })

  it('places a cut at the end of the file one past the last line', () => {
    expect(lineChangesOf(patchOf('@@ -1,2 +1 @@', ' a', '-b'))).toEqual([{ kind: 'removed', start: 2, end: 2 }])
  })

  it('reads a context-free deletion hunk from the line before the cut', () => {
    expect(lineChangesOf(patchOf('@@ -5 +4,0 @@', '-gone'))).toEqual([{ kind: 'removed', start: 5, end: 5 }])
  })

  it('marks a new file as added throughout, ignoring the no-newline note', () => {
    expect(lineChangesOf(patchOf('@@ -0,0 +1,2 @@', '+a', '+b', '\\ No newline at end of file'))).toEqual([{ kind: 'added', start: 1, end: 2 }])
  })

  it('keeps line numbers right across several hunks', () => {
    const patch = patchOf('@@ -1,2 +1,3 @@', ' a', '+x', ' b', '@@ -10,3 +11,3 @@', ' j', '-k', '+K', ' l')
    expect(lineChangesOf(patch)).toEqual([
      { kind: 'added', start: 2, end: 2 },
      { kind: 'modified', start: 12, end: 12 }
    ])
  })
})
