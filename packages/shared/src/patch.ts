/**
 * Unified-patch utilities shared by the daemon (which stages hunks into the index) and the UI
 * (which renders and picks them), so "hunk 3" can never mean two different things on the two
 * sides of the wire.
 */

/** One hunk of a single-file unified patch. */
export interface PatchHunk {
  /** Position in the file's hunk list; what the wire refers to. */
  index: number
  /** The `@@ -a,b +c,d @@ …` line itself. */
  header: string
  /** Body lines with their leading ' ', '+', '-' or '\' marker, newlines stripped. */
  lines: string[]
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  additions: number
  deletions: number
}

export interface SplitPatch {
  /** Everything before the first hunk: `diff --git`, mode/index lines, `---`/`+++`. */
  header: string
  hunks: PatchHunk[]
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** Splits one file's unified patch into its preamble and hunks. A patch with no `@@` yields none. */
export function splitPatch(patch: string): SplitPatch {
  const lines = patch.split('\n')
  const header: string[] = []
  const hunks: PatchHunk[] = []
  let current: PatchHunk | undefined

  for (const line of lines) {
    const match = HUNK_HEADER.exec(line)
    if (match) {
      current = {
        index: hunks.length,
        header: line,
        lines: [],
        // A count omitted from the header means 1; `-0,0` marks a pure insertion.
        oldStart: Number(match[1]),
        oldLines: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newLines: match[4] === undefined ? 1 : Number(match[4]),
        additions: 0,
        deletions: 0
      }
      hunks.push(current)
      continue
    }
    if (!current) {
      header.push(line)
      continue
    }
    // git's trailing newline leaves one empty element that belongs to no line.
    if (line === '') continue
    current.lines.push(line)
    if (line[0] === '+') current.additions++
    else if (line[0] === '-') current.deletions++
  }

  return { header: header.join('\n'), hunks }
}

/** FNV-1a over the patch text — the same hash `diff-view.tsx` uses for its cache keys. */
export function hashPatch(patch: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < patch.length; index += 1) {
    hash ^= patch.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

interface OutLine {
  text: string
  /** Set by a `\ No newline at end of file` marker that applies to this line. */
  noEol: boolean
}

/** A file as lines without their newlines, plus whether the file ended with one. */
function toLines(text: string): { lines: string[]; eol: boolean } {
  if (text === '') return { lines: [], eol: true }
  const eol = text.endsWith('\n')
  const lines = text.split('\n')
  if (eol) lines.pop()
  return { lines, eol }
}

/**
 * The content that results from applying only `selected` hunks of `hunks` to `baseText` —
 * what a partially staged file's blob has to contain. Pure, so it is unit-testable without git.
 *
 * The subtle part is `\ No newline at end of file`: it is metadata attached to the line *before*
 * it and it names one side only, so a marker after a `-` line says the pre-image lacked the
 * newline and must not be copied onto the line being emitted. Getting that wrong silently adds or
 * drops a trailing newline in the staged blob.
 */
export function applyHunks(baseText: string, hunks: readonly PatchHunk[], selected: Iterable<number>): string {
  const pick = new Set(selected)
  const base = toLines(baseText)
  const out: OutLine[] = []
  let cursor = 0

  const copyBase = (upto: number): void => {
    for (; cursor < upto && cursor < base.lines.length; cursor++) {
      out.push({ text: base.lines[cursor] as string, noEol: !base.eol && cursor === base.lines.length - 1 })
    }
  }

  for (const hunk of [...hunks].sort((a, b) => a.oldStart - b.oldStart || a.index - b.index)) {
    // A pure insertion (`-N,0`) sits *after* old line N; every other hunk starts at N.
    const at = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1
    copyBase(at)
    if (!pick.has(hunk.index)) {
      copyBase(at + hunk.oldLines)
      continue
    }
    let previous = ' '
    for (const line of hunk.lines) {
      const marker = line[0] ?? ' '
      if (marker === '\\') {
        // Applies to the new side only when the line it follows is on the new side.
        if (previous === '+' || previous === ' ') {
          const last = out[out.length - 1]
          if (last) last.noEol = true
        }
        continue
      }
      previous = marker
      if (marker === '-') continue
      out.push({ text: line.slice(1), noEol: false })
    }
    cursor = at + hunk.oldLines
  }
  copyBase(base.lines.length)

  if (out.length === 0) return ''
  return out.map((line) => line.text).join('\n') + ((out[out.length - 1] as OutLine).noEol ? '' : '\n')
}
