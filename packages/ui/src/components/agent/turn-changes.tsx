import type { DiffSpec, Worktree } from '@canopy/shared'

import { DiffExplorer } from '@/components/git/diff-explorer'
import { useComments, useDiffFiles } from '@/lib/api-hooks'
import { plural } from '@/lib/format'
import type { TurnSnapshot } from '@/lib/turn-changes'

const WORKING_TREE = { kind: 'worktree', against: 'head' } as const

/** What one turn changed, as a diff to show: exact snapshots when hooks recorded them, else the named files' current diff. */
export interface TurnReview {
  prompt: string
  files: string[]
  snapshot?: TurnSnapshot
}

const specFor = (review: TurnReview): DiffSpec => (review.snapshot ? { kind: 'trees', before: review.snapshot.before, after: review.snapshot.after } : WORKING_TREE)

/**
 * The files one agent turn wrote, through the same explorer (and comments) as the Git Diff
 * tab. With a hook snapshot the diff is exactly that turn's; without one it is the current
 * uncommitted diff of the files the turn named, and files clean again are only counted.
 */
export function TurnChanges({ worktree, review, className }: { worktree: Worktree; review: TurnReview; className?: string }): React.JSX.Element {
  const spec = specFor(review)
  const changes = useDiffFiles(worktree.id, spec)
  const comments = useComments(worktree.id).data ?? []
  const wanted = new Set(review.files)
  const files = (changes.data?.files ?? []).filter((file) => wanted.has(file.path))
  const clean = review.files.length - files.length
  const unattributed = review.snapshot?.unattributed ?? []

  return (
    <div className={className}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="shrink-0 border-b border-border px-3 py-2">
          <div className="min-w-0">
            <p className="m-0 text-xs font-medium">
              {plural(review.files.length, 'file')} {review.snapshot ? 'changed in this turn' : 'edited'}
              {!review.snapshot && clean > 0 ? ` · ${clean} since committed or reverted` : ''}
              {unattributed.length > 0 ? ` · ${unattributed.length} possibly by another agent` : ''}
            </p>
            <p className="m-0 line-clamp-2 text-[11px] text-muted-foreground" title={review.prompt}>
              {review.prompt}
            </p>
          </div>
        </div>
        {changes.isPending ? <p className="p-3 font-mono text-[11px] text-muted-foreground">Reading changes…</p> : null}
        {changes.error ? <p className="p-3 text-xs text-destructive">{changes.error.message}</p> : null}
        {changes.data && files.length === 0 ? (
          <div className="p-3 text-xs text-muted-foreground">
            <p className="m-0 mb-2">Nothing uncommitted remains from this turn.</p>
            <ul className="m-0 list-none p-0 font-mono text-[11px]">
              {review.files.map((file) => (
                <li key={file} className="truncate">
                  {file}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {files.length > 0 ? <DiffExplorer worktreeId={worktree.id} spec={spec} files={files} comments={comments.filter((c) => !c.commitSha)} mode="unified" className="min-h-0 flex-1" /> : null}
      </div>
    </div>
  )
}
