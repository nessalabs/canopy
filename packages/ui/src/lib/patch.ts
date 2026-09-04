import type { CommentSide } from '@canopy/shared'

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
