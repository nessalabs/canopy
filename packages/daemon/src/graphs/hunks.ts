/**
 * Every hunk of a change under a short id, for an agent brief. The agent answers with those ids;
 * the UI reads them back (`graphFromAnswer` in shared) so each hunk lands in exactly one node
 * whatever it wrote.
 *
 * Hunks are cut with the same `splitPatch` the UI renders with, from the same two pinned trees
 * it shows the graph against, so `{ path, hunk: 3 }` is the same hunk on both sides of the wire.
 */
import { lineKey, splitPatch } from '@canopy/shared'
import type { ChangedFile, DiffSpec, HunkRef } from '@canopy/shared'

import type { HistoryService } from '../worktrees/history'

/** A hunk body past this many lines is cut short; its header still says how big it is. */
const MAX_HUNK_LINES = 60
/** Past this many characters of hunk bodies, the rest go in as headers alone. */
const MAX_BODY_CHARS = 120_000
/** Patches are read this many files at a time, so a large change does not fork hundreds of gits at once. */
const PATCH_BATCH = 8

export interface FileDiff {
  file: ChangedFile
  /** Null when there is no text diff to split: binary, too large, rename-only. */
  patch: string | null
}

export interface HunkTable {
  /** Every id the prompt mentions, in the order the diff reads. */
  refs: Map<string, HunkRef>
  /** Lines each hunk adds and removes, by `lineKey`; a whole file counts as its diff stat says. */
  lines: Map<string, [number, number]>
  text: string
}

/** One hunk as the prompt shows it: its id and header, then as much of its body as the budget allows. */
function hunkLines(id: string, header: string, body: string[], budget: { left: number }): string[] {
  const shown = body.slice(0, MAX_HUNK_LINES).join('\n')
  if (shown.length > budget.left) return [`${id} ${header}`, '[body left out; the change is too large to include every hunk]']
  budget.left -= shown.length
  const more = body.length - MAX_HUNK_LINES
  return [`${id} ${header}`, shown, ...(more > 0 ? [`[… ${more} more lines]`] : [])]
}

/** Added and removed lines in a hunk's body. */
const countLines = (body: string[]): [number, number] => [body.filter((line) => line.startsWith('+')).length, body.filter((line) => line.startsWith('-')).length]

/** Numbers every hunk (`h…`) and every file with no hunks (`f…`), and writes them out for the prompt. */
export function hunkTable(files: FileDiff[], maxBodyChars = MAX_BODY_CHARS): HunkTable {
  const refs = new Map<string, HunkRef>()
  const lines = new Map<string, [number, number]>()
  const budget = { left: maxBodyChars }
  const text = files.flatMap(({ file, patch }) => {
    const hunks = patch ? splitPatch(patch).hunks : []
    const title = `### ${file.path} (${file.binary ? 'binary' : `+${file.additions} -${file.deletions}`})`
    if (hunks.length === 0) {
      const id = `f${refs.size + 1}`
      refs.set(id, { path: file.path })
      lines.set(lineKey({ path: file.path }), [file.additions, file.deletions])
      return [title, `${id} whole file`]
    }
    return [
      title,
      ...hunks.flatMap((hunk) => {
        const id = `h${refs.size + 1}`
        refs.set(id, { path: file.path, hunk: hunk.index })
        lines.set(lineKey({ path: file.path, hunk: hunk.index }), countLines(hunk.lines))
        return hunkLines(id, hunk.header, hunk.lines, budget)
      })
    ]
  })
  return { refs, lines, text: text.join('\n') }
}

/** Each file's patch between the two trees; a binary file has none. */
export async function readPatches(history: Pick<HistoryService, 'filePatch'>, worktreeId: string, spec: DiffSpec, files: ChangedFile[]): Promise<FileDiff[]> {
  const out: FileDiff[] = []
  for (let at = 0; at < files.length; at += PATCH_BATCH) {
    const batch = files.slice(at, at + PATCH_BATCH)
    const patches = await Promise.all(batch.map((file) => (file.binary ? null : history.filePatch(worktreeId, spec, file.path).then((p) => p.patch))))
    out.push(...batch.map((file, i) => ({ file, patch: patches[i] ?? null })))
  }
  return out
}
