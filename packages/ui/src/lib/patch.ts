import { splitPatch, type CommentSide } from '@canopy/shared'

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/**
 * The source text of one line in a unified patch, addressed the way a comment is:
 * by side ('old' = deletions, 'new' = additions/context) and line number.
 */
export function lineAt(patch: string, side: CommentSide, line: number): string | undefined {
  let oldNo = 0
  let newNo = 0
  let inHunk = false
  for (const raw of patch.split('\n')) {
    const hunk = HUNK.exec(raw)
    if (hunk) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      inHunk = true
      continue
    }
    if (!inHunk || raw === '' || raw.startsWith('\\')) continue
    const marker = raw[0]
    const text = raw.slice(1)
    const matches = (side === 'old' && marker !== '+' && oldNo === line) || (side === 'new' && marker !== '-' && newNo === line)
    if (matches) return text
    if (marker !== '+') oldNo++
    if (marker !== '-') newNo++
  }
  return undefined
}

/**
 * One file's patch cut down to the chosen hunks — header kept, since the diff renderer needs it to
 * know the file and its language — with what those hunks add and remove.
 */
export function slicePatch(patch: string, hunks?: number[]): { patch: string; additions: number; deletions: number } {
  const split = splitPatch(patch)
  const chosen = hunks ? split.hunks.filter((hunk) => hunks.includes(hunk.index)) : split.hunks
  if (!hunks) return { patch, additions: sum(chosen, 'additions'), deletions: sum(chosen, 'deletions') }
  const body = chosen.flatMap((hunk) => [hunk.header, ...hunk.lines])
  return { patch: `${split.header}\n${body.join('\n')}\n`, additions: sum(chosen, 'additions'), deletions: sum(chosen, 'deletions') }
}

const sum = (hunks: Array<{ additions: number; deletions: number }>, key: 'additions' | 'deletions'): number => hunks.reduce((total, hunk) => total + hunk[key], 0)
