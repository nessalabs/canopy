import { describe, expect, it } from 'vitest'

import { applyHunks, hashPatch, splitPatch } from '../src/patch'

/** Builds the patch git itself would produce, so the fixtures cannot drift from reality. */
const patchOf = (hunks: string[], header = 'diff --git a/f b/f\n--- a/f\n+++ b/f'): string => `${header}\n${hunks.join('\n')}\n`

describe('splitPatch', () => {
  it('separates the preamble from the hunks and counts each side', () => {
    const patch = patchOf(['@@ -1,3 +1,4 @@', ' a', '-b', '+B', '+b2', ' c', '@@ -10 +11 @@', '-x', '+X'])
    const { header, hunks } = splitPatch(patch)
    expect(header).toBe('diff --git a/f b/f\n--- a/f\n+++ b/f')
    expect(hunks).toHaveLength(2)
    expect(hunks[0]).toMatchObject({ index: 0, oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, additions: 2, deletions: 1 })
    // A header with no comma means a single line on that side.
    expect(hunks[1]).toMatchObject({ index: 1, oldStart: 10, oldLines: 1, newStart: 11, newLines: 1 })
  })

  it('yields no hunks for a patch that has none (binary, or an empty diff)', () => {
    expect(splitPatch('diff --git a/f b/f\nBinary files a/f and b/f differ\n').hunks).toEqual([])
    expect(splitPatch('').hunks).toEqual([])
  })
})

describe('applyHunks', () => {
  const base = 'a\nb\nc\nd\ne\n'
  const patch = patchOf(['@@ -1,2 +1,2 @@', '-a', '+A', ' b', '@@ -4,2 +4,2 @@', ' d', '-e', '+E'])
  const hunks = splitPatch(patch).hunks

  it('applying every hunk reproduces the new file, applying none reproduces the old', () => {
    expect(applyHunks(base, hunks, [0, 1])).toBe('A\nb\nc\nd\nE\n')
    expect(applyHunks(base, hunks, [])).toBe(base)
  })

  it('applies a single hunk and leaves the rest of the file alone', () => {
    expect(applyHunks(base, hunks, [0])).toBe('A\nb\nc\nd\ne\n')
    expect(applyHunks(base, hunks, [1])).toBe('a\nb\nc\nd\nE\n')
  })

  it('inserts a pure-insertion hunk after the line its header names', () => {
    const insertion = splitPatch(patchOf(['@@ -2,0 +3,2 @@', '+x', '+y'])).hunks
    expect(applyHunks(base, insertion, [0])).toBe('a\nb\nx\ny\nc\nd\ne\n')
  })

  it('builds a new file from an empty base', () => {
    const added = splitPatch(patchOf(['@@ -0,0 +1,2 @@', '+one', '+two'])).hunks
    expect(applyHunks('', added, [0])).toBe('one\ntwo\n')
    expect(applyHunks('', added, [])).toBe('')
  })

  it('empties the file when a whole-file deletion is applied', () => {
    const deletion = splitPatch(patchOf(['@@ -1,5 +0,0 @@', '-a', '-b', '-c', '-d', '-e'])).hunks
    expect(applyHunks(base, deletion, [0])).toBe('')
  })

  it('keeps a missing trailing newline that only the new side lacks', () => {
    const trimmed = splitPatch(patchOf(['@@ -5 +5 @@', '-e', '+E', '\\ No newline at end of file'])).hunks
    expect(applyHunks(base, trimmed, [0])).toBe('a\nb\nc\nd\nE')
  })

  it('does not copy a no-newline marker that belongs to the old side onto the new line', () => {
    // Base lacks the trailing newline; the patch restores it, so the marker follows the `-` line.
    const restored = splitPatch(patchOf(['@@ -5 +5 @@', '-e', '\\ No newline at end of file', '+E'])).hunks
    expect(applyHunks('a\nb\nc\nd\ne', restored, [0])).toBe('a\nb\nc\nd\nE\n')
  })

  it('preserves a base that has no trailing newline when the hunk does not touch its last line', () => {
    const early = splitPatch(patchOf(['@@ -1 +1 @@', '-a', '+A'])).hunks
    expect(applyHunks('a\nb\nc', early, [0])).toBe('A\nb\nc')
  })

  it('treats CRLF as ordinary line content', () => {
    const crlf = splitPatch(patchOf(['@@ -1 +1 @@', '-a\r', '+A\r'])).hunks
    expect(applyHunks('a\r\nb\r\n', crlf, [0])).toBe('A\r\nb\r\n')
  })
})

describe('hashPatch', () => {
  it('is stable and separates different patches', () => {
    expect(hashPatch('abc')).toBe(hashPatch('abc'))
    expect(hashPatch('abc')).not.toBe(hashPatch('abd'))
  })
})
