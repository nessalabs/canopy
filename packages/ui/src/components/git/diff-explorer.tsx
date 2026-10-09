import { useEffect, useMemo } from 'react'

import type { ChangedFile, DiffSpec, ReviewComment } from '@canopy/shared'

import type { DiffMode } from '@/components/worktree-diff'
import { DiffStat, FileDiffPath } from '@/components/ui/file-diff-list'
import type { LineRange } from '@/lib/file-refs'
import { plural } from '@/lib/format'
import { groupBy } from '@/lib/group'
import { useFileTrail } from '@/lib/use-file-trail'
import { useHighlighterWarmup } from '@/lib/use-highlighter-warmup'
import { useIdlePreload } from '@/lib/use-idle-preload'

import { ContentPane, LooseFilePane } from './content-pane'
import { preloadCodeEditor } from './file-viewer'
import { ExplorerShell } from './explorer-shell'
import { ChangedFilesTree, type CommitSelection } from './file-tree'

/** A change set in numbers: how many files, and the lines it adds and removes. */
export function FilesSummary({ files }: { files: ChangedFile[] }): React.JSX.Element {
  const totals = files.reduce((sum, f) => ({ additions: sum.additions + f.additions, deletions: sum.deletions + f.deletions }), { additions: 0, deletions: 0 })
  return (
    <span className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
      {plural(files.length, 'file')}
      <DiffStat additions={totals.additions} deletions={totals.deletions} />
    </span>
  )
}

/** Where the explorer should land: a file, and optionally a comment or the lines inside it to scroll to. */
export interface ExplorerFocus {
  path: string
  commentId?: string
  lines?: LineRange
}

/**
 * The one file explorer for any DiffSpec: changed-files tree plus the selected file's diff or
 * contents. Wide containers show them side by side, medium ones stack them, narrow ones keep
 * the tree behind a button. Only the selected file's content is mounted, so a change set with
 * thousands of files costs one tree, not thousands of diffs.
 */
export function DiffExplorer({
  worktreeId,
  spec,
  files,
  comments,
  mode,
  focus,
  commit,
  treeMeta,
  treeFooter,
  className
}: {
  worktreeId: string
  spec: DiffSpec
  files: ChangedFile[]
  comments: ReviewComment[]
  mode: DiffMode
  focus?: ExplorerFocus
  /** Present only in the commit panel: checkboxes, mouse selection and the right-click menu. */
  commit?: CommitSelection
  /** Beside the tree's label; the file count and line totals unless the caller says more. */
  treeMeta?: React.ReactNode
  /** The commit box, pinned under the tree. */
  treeFooter?: React.ReactNode
  className?: string
}): React.JSX.Element {
  // Start resolving the grammars this change set needs now, not when a file is first clicked.
  useHighlighterWarmup(useMemo(() => files.map((file) => file.path), [files]))
  // The File tab and any doc link out of a change set open the editor; fetch it once the screen is idle.
  useIdlePreload(preloadCodeEditor)
  // Where the pane is, and how it got there. An empty trail means the first changed file,
  // whatever that is today; a focus handed in from outside starts the trail over there.
  const trail = useFileTrail(files[0]?.path)
  const { go, reset } = trail
  useEffect(() => {
    if (focus === undefined) reset()
    else go(focus.path, focus.lines ? `L${focus.lines.start}` : undefined)
  }, [focus, go, reset])
  const stop = trail.current
  const selectedPath = stop?.path
  const selected = files.find((f) => f.path === selectedPath)
  const byFile = useMemo(() => groupBy(comments, (c) => c.file), [comments])
  const counts = useMemo(() => new Map([...byFile].map(([file, list]) => [file, list.length])), [byFile])

  const tree = <ChangedFilesTree files={files} commentCounts={counts} selected={selectedPath} onSelect={go} commit={commit} className="h-full" />
  const content = selected ? (
    <ContentPane
      key={selected.path}
      worktreeId={worktreeId}
      spec={spec}
      file={selected}
      comments={byFile.get(selected.path) ?? []}
      mode={mode}
      focusCommentId={focus?.path === selected.path ? focus.commentId : undefined}
      focusLines={focus?.path === selected.path ? focus.lines : undefined}
      canPickHunks={commit !== undefined}
      anchor={stop?.hash}
      onOpenPath={trail.open}
      onBack={trail.back}
    />
  ) : stop ? (
    // A doc linked somewhere the change set does not reach — read it anyway, outside the diff.
    <LooseFilePane key={stop.path} worktreeId={worktreeId} spec={spec} path={stop.path} anchor={stop.hash} onOpenPath={trail.open} onBack={trail.back} />
  ) : null

  return (
    <ExplorerShell
      className={className}
      treeLabel="Changed files"
      overlayHeader={selectedPath ? <FileDiffPath path={selectedPath} className="min-w-0 flex-1 font-mono text-xs" /> : null}
      tree={tree}
      treeMeta={treeMeta ?? <FilesSummary files={files} />}
      treeFooter={treeFooter}
      content={content}
    />
  )
}
