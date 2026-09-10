/**
 * A rendered diff of one markdown file: the new document as prose, with the blocks the change
 * touched marked, and the blocks it deleted rendered where they used to be. The unit is the
 * markdown block, not the line — half a paragraph or three rows of a table cannot be rendered on
 * their own, so a block any changed line falls inside is marked whole.
 */
import { splitPatch } from '@canopy/shared'

export type SegmentKind = 'context' | 'added' | 'removed'

/** One run of markdown source, and how the change set treats it. */
export interface DiffSegment {
  kind: SegmentKind
  /** Markdown source, ready to render on its own. */
  text: string
  /** First line of the new file this run covers; a removed run has none, so it carries its anchor. */
  line: number
}

/** Lines deleted together, and the new-side line they sat before. */
interface Removal {
  anchor: number
  lines: string[]
}

/** The new-side lines the patch adds, and the deletions, each tied to where it happened. */
function changesOf(patch: string): { added: Set<number>; removals: Removal[] } {
  const added = new Set<number>()
  const removals: Removal[] = []

  for (const hunk of splitPatch(patch).hunks) {
    let line = hunk.newStart
    let run: Removal | undefined
    for (const text of hunk.lines) {
      // "\ No newline at end of file" annotates the line before it and consumes no line number.
      if (text[0] === '\\') continue
      if (text[0] === '+') {
        added.add(line)
        line += 1
        run = undefined
        continue
      }
      if (text[0] === '-') {
        if (!run) {
          run = { anchor: line, lines: [] }
          removals.push(run)
        }
        run.lines.push(text.slice(1))
        continue
      }
      line += 1
      run = undefined
    }
  }

  return { added, removals }
}

/** A fence opens and closes a code block; nothing inside one starts or ends a block of its own. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const LIST_ITEM = /^ *([-*+]|\d{1,9}[.)]) /

/** Whether a blank line at `at` is inside a list or an indented block rather than ending one. */
function continues(lines: string[], at: number, start: number): boolean {
  const next = lines.findIndex((line, index) => index > at && line.trim() !== '')
  if (next === -1) return false
  // An indented continuation belongs to the block above it; so does a sibling item of the same list.
  return /^ {2,}\S/.test(lines[next]) || (LIST_ITEM.test(lines[next]) && LIST_ITEM.test(lines[start - 1]))
}

/** One markdown block: a run of lines rendered together, blank separators kept with it. */
interface Block {
  start: number
  end: number
}

/** Splits a document into top-level blocks, 1-based and contiguous, so joining them restores it. */
export function blocksOf(lines: string[]): Block[] {
  const blocks: Block[] = []
  let start: number | undefined
  let fence: string | undefined

  lines.forEach((line, index) => {
    const at = index + 1
    const fenced = FENCE.exec(line)
    if (fence !== undefined) {
      if (fenced && fenced[1][0] === fence[0] && fenced[1].length >= fence.length) fence = undefined
      return
    }
    if (line.trim() === '') {
      if (start !== undefined) {
        if (continues(lines, index, start)) return
        blocks.push({ start, end: at })
        start = undefined
        return
      }
      // Blank lines before any block, or piled after one, stay with whatever they follow.
      if (blocks.length === 0) blocks.push({ start: at, end: at })
      else blocks[blocks.length - 1].end = at
      return
    }
    if (start === undefined) start = at
    if (fenced) fence = fenced[1]
  })

  if (start !== undefined) blocks.push({ start, end: lines.length })
  return blocks
}

/**
 * The new document cut into runs of blocks that share a fate, with each deleted run placed before
 * the block that replaced it. Rendering the segments in order reproduces the whole file.
 */
export function diffSegments(newText: string, patch: string): DiffSegment[] {
  const { added, removals } = changesOf(patch)
  const lines = newText.split('\n')
  // A file's closing newline leaves a trailing element that is not a line of the document.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  const segments: DiffSegment[] = []
  let run: { kind: 'context' | 'added'; start: number; end: number } | undefined
  const flush = (): void => {
    if (run) segments.push({ kind: run.kind, text: lines.slice(run.start - 1, run.end).join('\n'), line: run.start })
    run = undefined
  }

  let at = 0
  for (const block of blocksOf(lines)) {
    // Anything deleted at or before this block's last line was deleted from it, or just above it.
    while (at < removals.length && removals[at].anchor <= block.end) {
      flush()
      segments.push({ kind: 'removed', text: removals[at].lines.join('\n'), line: removals[at].anchor })
      at += 1
    }
    let kind: 'context' | 'added' = 'context'
    // A blank line added between two blocks belongs to neither: counting it would light up the
    // paragraph a new section was appended after, which the change never touched.
    for (let line = block.start; line <= block.end; line += 1) if (added.has(line) && lines[line - 1].trim() !== '') kind = 'added'
    if (run && run.kind === kind) run.end = block.end
    else {
      flush()
      run = { kind, start: block.start, end: block.end }
    }
  }
  flush()
  // Deletions past the end of the new file — the tail of the doc, cut.
  for (; at < removals.length; at += 1) segments.push({ kind: 'removed', text: removals[at].lines.join('\n'), line: removals[at].anchor })

  return segments.filter((segment) => segment.text.trim() !== '')
}
