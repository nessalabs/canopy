import type { ReviewComment } from '@canopy/shared'

import type { DiffMode } from '@/components/worktree-diff'
import { Badge } from '@/components/ui/badge'
import { useDiffFiles } from '@/lib/api-hooks'
import { absoluteTime } from '@/lib/format'

import { DiffExplorer, type ExplorerFocus } from './diff-explorer'
import { ReviewToolbar } from './review-toolbar'

export function CommitDetail({
  worktreeId,
  sha,
  comments,
  mode,
  onModeChange,
  onSendForReview,
  sending,
  focus
}: {
  worktreeId: string
  sha: string
  comments: ReviewComment[]
  mode: DiffMode
  onModeChange: (mode: DiffMode) => void
  onSendForReview: () => void
  sending: boolean
  focus?: ExplorerFocus
}): React.JSX.Element {
  const spec = { kind: 'commit', sha } as const
  const detail = useDiffFiles(worktreeId, spec)
  const data = detail.data && 'commit' in detail.data ? detail.data : undefined
  const forCommit = comments.filter((comment) => comment.commitSha === sha)

  if (detail.isPending) return <p className="p-4 font-mono text-xs text-muted-foreground">Loading commit…</p>
  if (detail.error || !data) return <p className="p-4 text-xs text-destructive">{detail.error?.message ?? 'Commit not found'}</p>

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">{data.commit.subject}</h3>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
          <span>{data.commit.author}</span>
          <span>{absoluteTime(data.commit.at)}</span>
          <Badge variant="outline" className="font-mono text-[10px]">
            {data.commit.shortSha}
          </Badge>
          {data.commit.parents.map((parent) => (
            <span key={parent}>parent {parent.slice(0, 7)}</span>
          ))}
        </p>
      </div>
      <ReviewToolbar files={data.files} comments={forCommit} mode={mode} onModeChange={onModeChange} onSendForReview={onSendForReview} sending={sending} />
      <DiffExplorer worktreeId={worktreeId} spec={spec} files={data.files} comments={forCommit} mode={mode} focus={focus} className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border" />
    </div>
  )
}
