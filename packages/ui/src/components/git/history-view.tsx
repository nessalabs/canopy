import { useEffect, useState } from 'react'

import type { ReviewComment } from '@canopy/shared'

import type { DiffMode } from '@/components/worktree-diff'
import { SplitView, SplitViewOrientation, SplitViewPanel, SplitViewSeparator } from '@/components/split-view'
import { useLog } from '@/lib/api-hooks'

import { CommitDetail } from './commit-detail'
import type { ExplorerFocus } from './diff-explorer'
import { CommitList } from './commit-list'

/** Commit list on the left, the selected commit's files and diffs on the right. */
export function HistoryView({
  worktreeId,
  comments,
  mode,
  onModeChange,
  onSendForReview,
  sending,
  focusCommit,
  focus
}: {
  worktreeId: string
  comments: ReviewComment[]
  mode: DiffMode
  onModeChange: (mode: DiffMode) => void
  onSendForReview: () => void
  sending: boolean
  /** A commit to select (a jump from the Comments pane). */
  focusCommit?: string
  focus?: ExplorerFocus
}): React.JSX.Element {
  const log = useLog(worktreeId)
  const commits = log.data?.pages.flatMap((page) => page.commits) ?? []
  const [selected, setSelected] = useState<string>()
  const current = selected ?? commits[0]?.sha

  useEffect(() => {
    if (selected && !commits.some((c) => c.sha === selected)) setSelected(undefined)
  }, [commits, selected])
  useEffect(() => setSelected(focusCommit), [focusCommit])

  if (log.isPending) return <p className="py-6 text-center font-mono text-xs text-muted-foreground">Reading history…</p>
  if (log.error) return <p className="text-xs text-destructive">{log.error.message}</p>
  if (commits.length === 0) return <div className="rounded-xl border border-border py-10 text-center text-sm text-muted-foreground">No commits yet.</div>

  return (
    <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border">
      <SplitView orientation={SplitViewOrientation.Horizontal} className="h-full">
        <SplitViewPanel id="commits" defaultSize={32} minSize={20} className="min-h-0 border-r border-border bg-card">
          <CommitList
            commits={commits}
            selected={current}
            onSelect={setSelected}
            hasMore={log.hasNextPage}
            loadingMore={log.isFetchingNextPage}
            onLoadMore={() => void log.fetchNextPage()}
          />
        </SplitViewPanel>
        <SplitViewSeparator />
        <SplitViewPanel id="detail" minSize={40} className="min-h-0">
          {current ? (
            <CommitDetail worktreeId={worktreeId} sha={current} comments={comments} mode={mode} onModeChange={onModeChange} onSendForReview={onSendForReview} sending={sending} focus={focus} />
          ) : null}
        </SplitViewPanel>
      </SplitView>
    </div>
  )
}
