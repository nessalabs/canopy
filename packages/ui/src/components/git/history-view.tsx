import { useEffect, useMemo, useState } from 'react'
import { Network } from 'lucide-react'

import type { Commit, ReviewComment } from '@canopy/shared'

import type { DiffMode } from '@/components/worktree-diff'
import { SplitView, SplitViewOrientation, SplitViewPanel, SplitViewSeparator } from '@/components/split-view'
import { Button } from '@/components/ui/button'
import { useLog } from '@/lib/api-hooks'
import { plural } from '@/lib/format'
import { useHotkeys } from '@/lib/use-hotkeys'

import { CommitDetail } from './commit-detail'
import type { ExplorerFocus } from './diff-explorer'
import { CommitList } from './commit-list'
import type { CommitRange } from './graph/graph-bar'

/** Whether rows, newest first, follow one another along first parents: each row's first parent is the row under it. */
export const isFirstParentLine = (rows: readonly Pick<Commit, 'sha' | 'parents'>[]): boolean => rows.every((row, i) => i === rows.length - 1 || row.parents[0] === rows[i + 1]!.sha)

/**
 * Commit list on the left, the selected commit's files and diffs on the right. Shift-click
 * stretches a run of commits from the selected one, which can then be drawn as a graph.
 */
export function HistoryView({
  worktreeId,
  comments,
  mode,
  focusCommit,
  focus,
  onGraph
}: {
  worktreeId: string
  comments: ReviewComment[]
  mode: DiffMode
  /** A commit to select (a jump from the Comments pane). */
  focusCommit?: string
  focus?: ExplorerFocus
  /** Draws a picked run of commits as a graph. */
  onGraph?: (range: CommitRange) => void
}): React.JSX.Element {
  const log = useLog(worktreeId)
  const commits = log.data?.pages.flatMap((page) => page.commits) ?? []
  const [selected, setSelected] = useState<string>()
  const current = selected ?? commits[0]?.sha
  const [end, setEnd] = useState<string>()
  // The run between the selected commit and the shift-clicked one, newest first as the list reads.
  const run = useMemo(() => {
    const [a, b] = [commits.findIndex((c) => c.sha === current), commits.findIndex((c) => c.sha === end)]
    if (a < 0 || b < 0 || a === b) return []
    return commits.slice(Math.min(a, b), Math.max(a, b) + 1)
  }, [commits, current, end])
  const marked = useMemo(() => new Set(run.map((c) => c.sha)), [run])
  // The daemon reads a run along first parents, from the oldest's parent to the newest; rows that
  // are not one such line (a merged branch's commits interleaved by date) would graph other commits.
  const linear = isFirstParentLine(run)
  useHotkeys(run.length > 1 ? { Escape: () => setEnd(undefined) } : {})
  const select = (sha: string, extend: boolean): void => {
    // Ticking the run's far end again, or the selected commit itself, lets the run go.
    if (extend && current) setEnd(sha === end || sha === current ? undefined : sha)
    else {
      setSelected(sha)
      setEnd(undefined)
    }
  }

  useEffect(() => {
    // Only once the log is in: an empty list while it loads would drop a commit a link asked for.
    if (log.data && selected && !commits.some((c) => c.sha === selected)) setSelected(undefined)
  }, [log.data, commits, selected])
  useEffect(() => setSelected(focusCommit), [focusCommit])

  if (log.isPending) return <p className="py-6 text-center font-mono text-xs text-muted-foreground">Reading history…</p>
  if (log.error) return <p className="text-xs text-destructive">{log.error.message}</p>
  if (commits.length === 0) return <div className="py-10 text-center text-sm text-muted-foreground">No commits yet.</div>

  return (
    <div className="min-h-0 flex-1 overflow-hidden">
      <SplitView orientation={SplitViewOrientation.Horizontal} className="h-full">
        <SplitViewPanel id="commits" defaultSize={32} minSize={20} className="flex min-h-0 flex-col border-r border-border bg-card">
          {onGraph ? (
            <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
              {run.length > 1 ? (
                <>
                  <span className="truncate" title={linear ? undefined : 'Pick commits that follow each other along first parents, without a merged branch’s commits between them'}>
                    {linear ? `${plural(run.length, 'commit')} picked` : 'Not one line of history'}
                  </span>
                  <Button size="sm" variant="ghost" className="ml-auto h-7 text-xs" onClick={() => setEnd(undefined)} title="Let go of the picked run  Esc">
                    Clear
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" disabled={!linear} onClick={() => onGraph({ from: run.at(-1)!.sha, to: run[0]!.sha, count: run.length })}>
                    <Network className="size-3.5" />
                    Graph these
                  </Button>
                </>
              ) : (
                <>
                  <span className="truncate">Tick or shift-click to pick a run of commits</span>
                  {current ? (
                    <Button size="sm" variant="ghost" className="ml-auto h-7 gap-1.5 text-xs" onClick={() => onGraph({ from: current, to: current, count: 1 })}>
                      <Network className="size-3.5" />
                      Graph this commit
                    </Button>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
          <div className="min-h-0 flex-1">
            <CommitList
              commits={commits}
              selected={current}
              onSelect={select}
              marked={marked}
              hasMore={log.hasNextPage}
              loadingMore={log.isFetchingNextPage}
              onLoadMore={() => void log.fetchNextPage()}
            />
          </div>
        </SplitViewPanel>
        <SplitViewSeparator />
        <SplitViewPanel id="detail" minSize={40} className="min-h-0">
          {current ? (
            <CommitDetail worktreeId={worktreeId} sha={current} comments={comments} mode={mode} focus={focus} />
          ) : null}
        </SplitViewPanel>
      </SplitView>
    </div>
  )
}
