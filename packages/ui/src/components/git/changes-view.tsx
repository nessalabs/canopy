import { useState } from 'react'
import { ArrowDown, ArrowUp, GitCommitHorizontal } from 'lucide-react'

import type { Against, ReviewComment, Worktree } from '@canopy/shared'

import type { DiffMode } from '@/components/worktree-diff'
import { SegmentedControl, SegmentedControlOption } from '@/components/ui/segmented-control'
import { useDiffFiles } from '@/lib/api-hooks'
import { relativeTime } from '@/lib/format'

import { DiffExplorer, type ExplorerFocus } from './diff-explorer'
import { ReviewToolbar } from './review-toolbar'

export function ChangesView({
  worktree,
  comments,
  mode,
  onModeChange,
  onSendForReview,
  sending,
  focus
}: {
  worktree: Worktree
  comments: ReviewComment[]
  mode: DiffMode
  onModeChange: (mode: DiffMode) => void
  onSendForReview: () => void
  sending: boolean
  focus?: ExplorerFocus
}): React.JSX.Element {
  const [against, setAgainst] = useState<Against>('head')
  const spec = { kind: 'worktree', against } as const
  const changes = useDiffFiles(worktree.id, spec)
  const files = changes.data?.files ?? []
  const last = worktree.status?.lastCommit
  const uncommitted = comments.filter((comment) => !comment.commitSha)

  return (
    <div className="flex flex-col gap-3">
      <ReviewToolbar files={files} comments={uncommitted} mode={mode} onModeChange={onModeChange} onSendForReview={onSendForReview} sending={sending}>
        <SegmentedControl value={against} onValueChange={(value) => setAgainst(value as Against)} aria-label="Compare against">
          <SegmentedControlOption value="head">vs HEAD</SegmentedControlOption>
          <SegmentedControlOption value="base">vs {worktree.baseBranch}</SegmentedControlOption>
        </SegmentedControl>
      </ReviewToolbar>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
        {last ? (
          <span className="flex items-center gap-1">
            <GitCommitHorizontal className="size-3.5" />"{last.subject}" — {last.author}, {relativeTime(last.at)}
          </span>
        ) : null}
        {worktree.status?.ahead !== null && worktree.status?.ahead !== undefined ? (
          <span className="flex items-center gap-0.5">
            <ArrowUp className="size-3" />
            {worktree.status.ahead} ahead
            <ArrowDown className="ml-1.5 size-3" />
            {worktree.status.behind} behind {worktree.baseBranch}
          </span>
        ) : null}
      </div>
      {changes.isPending ? <p className="py-6 text-center font-mono text-xs text-muted-foreground">Reading working tree…</p> : null}
      {changes.error ? <p className="text-xs text-destructive">{changes.error.message}</p> : null}
      {changes.data && files.length === 0 ? (
        <div className="rounded-xl border border-border py-10 text-center text-sm text-muted-foreground">
          {against === 'head' ? 'Working tree clean — edit something and the diff shows up here.' : `Nothing differs from ${worktree.baseBranch}.`}
        </div>
      ) : null}
      {files.length > 0 ? (
        <DiffExplorer worktreeId={worktree.id} spec={spec} files={files} comments={uncommitted} mode={mode} focus={focus} className="h-[calc(100vh-330px)] min-h-[420px] overflow-hidden rounded-xl border border-border" />
      ) : null}
    </div>
  )
}
