/**
 * The brief a grouping session starts from. Every hunk of the change goes to the agent under a
 * short id, and the agent answers in the Git Agent with groups of those ids; the UI reads them
 * back (`groupsFromAnswer` in shared) so each hunk lands in exactly one group whatever it wrote.
 *
 * Hunks are cut with the same `splitPatch` the UI renders with, so `{ path, hunk: 3 }` is the same
 * hunk on both sides of the wire.
 */
import { DEFAULT_GROUP_PROMPT, diffFingerprint, splitPatch } from '@canopy/shared'
import type { ChangedFile, GroupInput, GroupingBrief, HunkRef } from '@canopy/shared'

import { badRequest } from '../lib/errors'
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

/** Numbers every hunk (`h…`) and every file with no hunks (`f…`), and writes them out for the prompt. */
export function hunkTable(files: FileDiff[], maxBodyChars = MAX_BODY_CHARS): HunkTable {
  const refs = new Map<string, HunkRef>()
  const budget = { left: maxBodyChars }
  const text = files.flatMap(({ file, patch }) => {
    const hunks = patch ? splitPatch(patch).hunks : []
    const title = `### ${file.path} (${file.binary ? 'binary' : `+${file.additions} -${file.deletions}`})`
    if (hunks.length === 0) {
      const id = `f${refs.size + 1}`
      refs.set(id, { path: file.path })
      return [title, `${id} whole file`]
    }
    return [
      title,
      ...hunks.flatMap((hunk) => {
        const id = `h${refs.size + 1}`
        refs.set(id, { path: file.path, hunk: hunk.index })
        return hunkLines(id, hunk.header, hunk.lines, budget)
      })
    ]
  })
  return { refs, text: text.join('\n') }
}

export function groupsPrompt(table: string, instructions?: string): string {
  const asked = instructions ? [`How the user wants it grouped:\n${instructions}`] : []
  return [DEFAULT_GROUP_PROMPT, ...asked, `The change:\n${table}`].join('\n\n')
}

interface Deps {
  history: Pick<HistoryService, 'changes' | 'filePatch'>
}

async function readPatches(history: Deps['history'], worktreeId: string, spec: { kind: 'worktree'; against: GroupInput['against'] }, files: ChangedFile[]): Promise<FileDiff[]> {
  const out: FileDiff[] = []
  for (let at = 0; at < files.length; at += PATCH_BATCH) {
    const batch = files.slice(at, at + PATCH_BATCH)
    const patches = await Promise.all(batch.map((file) => (file.binary ? null : history.filePatch(worktreeId, spec, file.path).then((p) => p.patch))))
    out.push(...batch.map((file, i) => ({ file, patch: patches[i] ?? null })))
  }
  return out
}

/** What a grouping session starts from: the message for the agent, and the ids its answers will name hunks by. */
export async function groupBrief({ history }: Deps, worktreeId: string, input: GroupInput): Promise<GroupingBrief> {
  const spec = { kind: 'worktree', against: input.against } as const
  const { files } = await history.changes(worktreeId, spec)
  if (files.length === 0) throw badRequest('nothing_to_group', 'there are no changes to group')
  const table = hunkTable(await readPatches(history, worktreeId, spec, files))
  return { prompt: groupsPrompt(table.text, input.instructions), ids: Object.fromEntries(table.refs), fingerprint: diffFingerprint(files) }
}
