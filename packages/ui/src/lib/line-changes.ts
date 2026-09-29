/**
 * What a patch did to each line of the new file, for marking the file as it reads in full: lines
 * the change added, lines it rewrote, and the places lines were cut. A run of deletions followed
 * by additions pairs up line for line — those lines were replaced — and any additions left over
 * are new, the way an editor's gutter reads a change against its last save.
 */
import { splitPatch } from '@canopy/shared'

export type LineChangeKind = 'added' | 'modified' | 'removed'

/**
 * A run of new-file lines, 1-based and inclusive. A removal covers no line of the new file: it
 * marks the gap just above `start`, which is one past the last line when the file's end was cut.
 */
export interface LineChange {
  kind: LineChangeKind
  start: number
  end: number
}

/** The new file's changed lines, in file order, from one file's unified patch. */
export function lineChangesOf(patch: string): LineChange[] {
  const changes: LineChange[] = []

  for (const hunk of splitPatch(patch).hunks) {
    // With no new-side lines, the header names the line before the cut rather than the first line.
    let line = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart
    let start = line
    let removed = 0
    let added = 0

    const flush = (): void => {
      const replaced = Math.min(removed, added)
      if (replaced > 0) changes.push({ kind: 'modified', start, end: start + replaced - 1 })
      if (added > replaced) changes.push({ kind: 'added', start: start + replaced, end: start + added - 1 })
      if (removed > 0 && added === 0) changes.push({ kind: 'removed', start, end: start })
      removed = 0
      added = 0
    }

    for (const text of hunk.lines) {
      // "\ No newline at end of file" annotates the line before it and consumes no line number.
      if (text[0] === '\\') continue
      if (text[0] === '-' || text[0] === '+') {
        if (removed === 0 && added === 0) start = line
        if (text[0] === '-') removed += 1
        else {
          added += 1
          line += 1
        }
        continue
      }
      flush()
      line += 1
    }
    flush()
  }

  return changes
}
