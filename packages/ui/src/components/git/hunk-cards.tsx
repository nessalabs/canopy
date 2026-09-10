import { useMemo } from 'react'

import { splitPatch, type ChangedFile, type DiffSpec, type PatchHunk, type ReviewComment } from '@canopy/shared'

import { WorktreeDiff, type DiffMode } from '@/components/worktree-diff'
import { Checkbox } from '@/components/ui/checkbox'
import { useHunkStates, useStageHunks } from '@/lib/api-hooks'
import { plural } from '@/lib/format'

/**
 * Each card mounts its own diff renderer, which resolves grammars and highlights independently,
 * so a file chopped into hundreds of hunks would be hundreds of them. Past this many the file is
 * staged whole or not at all, which is the only choice that stays responsive.
 */
export const MAX_HUNK_CARDS = 40

const Note = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <p className="p-3 font-mono text-[11px] text-muted-foreground">{children}</p>
)

/** The comments that fall inside one hunk, so a card shows the threads that belong to it. */
const commentsIn = (comments: ReviewComment[], hunk: PatchHunk): ReviewComment[] =>
  comments.filter((comment) =>
    comment.side === 'new'
      ? comment.line >= hunk.newStart && comment.line < hunk.newStart + hunk.newLines
      : comment.line >= hunk.oldStart && comment.line < hunk.oldStart + hunk.oldLines
  )

/**
 * One file's hunks as a stack of cards, each with a checkbox that stages or unstages just that
 * hunk. The card renders through the same `WorktreeDiff` the whole-file view uses rather than a
 * bare diff, so line comments keep working inside a hunk.
 *
 * Toggling writes the index immediately: the checkbox means "this is staged", the same as in the
 * file list, and reloading the app must not lose the choice.
 */
export function HunkCards({
  worktreeId,
  spec,
  file,
  patch,
  comments,
  mode
}: {
  worktreeId: string
  spec: DiffSpec
  file: ChangedFile
  patch: string
  comments: ReviewComment[]
  mode: DiffMode
}): React.JSX.Element {
  const states = useHunkStates(worktreeId, file.path, true)
  const stage = useStageHunks(worktreeId)
  const { header, hunks } = useMemo(() => splitPatch(patch), [patch])

  if (states.isPending) return <Note>Reading what is staged…</Note>
  if (states.error) return <p className="p-3 text-xs text-destructive">{states.error.message}</p>
  if (hunks.length === 0) return <Note>Nothing to pick: this file has no text hunks.</Note>

  const staged = new Set(states.data.staged)
  const partial = new Set(states.data.partial)

  if (!states.data.representable) {
    return (
      <Note>
        {file.path} is staged in a way these hunks cannot describe — the same lines were staged as one thing and then edited to another. Stage or unstage the
        whole file to pick hunks again; rebuilding it from here would throw the staged version away.
      </Note>
    )
  }

  const toggle = (index: number): void => {
    const next = new Set(staged)
    // A mixed hunk becomes fully staged on the first click rather than emptying.
    if (next.has(index)) next.delete(index)
    else next.add(index)
    stage.mutate({ path: file.path, hunks: [...next], patchHash: states.data.patchHash })
  }

  const shown = hunks.slice(0, MAX_HUNK_CARDS)

  return (
    <div className="flex flex-col gap-3 p-3">
      {stage.error ? <p className="text-xs text-destructive">{stage.error.message}</p> : null}
      {shown.map((hunk) => (
        <div key={hunk.index} className="overflow-hidden rounded-xl border border-border">
          <WorktreeDiff
            worktreeId={worktreeId}
            spec={spec}
            path={file.path}
            // Pierre needs the `diff --git`/`---`/`+++` preamble to know the file and its language.
            patch={`${header}\n${hunk.header}\n${hunk.lines.join('\n')}\n`}
            comments={commentsIn(comments, hunk)}
            mode={mode}
            headerExtra={
              <label className="flex cursor-pointer items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
                <Checkbox
                  checked={staged.has(hunk.index)}
                  indeterminate={partial.has(hunk.index)}
                  disabled={stage.isPending}
                  onChange={() => toggle(hunk.index)}
                  className="size-3.5"
                  aria-label={`Include hunk ${hunk.index + 1} of ${hunks.length} in the commit`}
                />
                Hunk {hunk.index + 1}/{hunks.length} · {hunk.header.slice(0, hunk.header.indexOf('@@', 2) + 2)} · +{hunk.additions} −{hunk.deletions}
              </label>
            }
          />
        </div>
      ))}
      {hunks.length > shown.length ? (
        <Note>
          {plural(hunks.length - shown.length, 'further hunk')} not shown — this file has too many to pick through one at a time. Use the file's own checkbox to
          stage it whole.
        </Note>
      ) : null}
    </div>
  )
}
