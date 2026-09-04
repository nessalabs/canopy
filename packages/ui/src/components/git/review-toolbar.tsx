import { Bot } from 'lucide-react'

import type { ChangedFile, ReviewComment } from '@canopy/shared'

import type { DiffMode } from '@/components/worktree-diff'
import { Button } from '@/components/ui/button'
import { DiffStat } from '@/components/ui/file-diff-list'
import { SegmentedControl, SegmentedControlOption } from '@/components/ui/segmented-control'
import { plural } from '@/lib/format'

/** Toolbar shared by Changes and History: layout toggle, totals, and the send-for-review button. */
export function ReviewToolbar({
  files,
  comments,
  mode,
  onModeChange,
  onSendForReview,
  sending,
  children
}: {
  files: ChangedFile[]
  comments: ReviewComment[]
  mode: DiffMode
  onModeChange: (mode: DiffMode) => void
  onSendForReview: () => void
  sending: boolean
  /** Extra controls rendered after the layout toggle (e.g. the vs-HEAD/base switch). */
  children?: React.ReactNode
}): React.JSX.Element {
  const unsent = comments.filter((comment) => !comment.sent).length
  const totals = files.reduce((sum, f) => ({ additions: sum.additions + f.additions, deletions: sum.deletions + f.deletions }), { additions: 0, deletions: 0 })

  return (
    <div className="flex flex-wrap items-center gap-3">
      <SegmentedControl value={mode} onValueChange={(value) => onModeChange(value as DiffMode)} aria-label="Diff layout">
        <SegmentedControlOption value="unified">Unified</SegmentedControlOption>
        <SegmentedControlOption value="split">Split</SegmentedControlOption>
      </SegmentedControl>
      {children}
      <span className="font-mono text-[11px] text-muted-foreground">{plural(files.length, 'file')}</span>
      <DiffStat additions={totals.additions} deletions={totals.deletions} />
      <span className="ml-auto flex items-center gap-2">
        {comments.length > 0 ? <span className="font-mono text-[11px] text-muted-foreground">{plural(comments.length, 'comment')}</span> : null}
        <Button size="sm" className="h-8" disabled={unsent === 0 || sending} onClick={onSendForReview}>
          <Bot />
          Send {unsent > 0 ? unsent : ''} {unsent === 1 ? 'comment' : 'comments'} for review
        </Button>
      </span>
    </div>
  )
}
