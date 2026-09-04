import { useEffect, useMemo, useRef, useState } from 'react'
import { FolderTree } from 'lucide-react'
import { Popover } from 'radix-ui'

import type { ChangedFile, DiffSpec, ReviewComment } from '@canopy/shared'

import type { DiffMode } from '@/components/worktree-diff'
import { SplitView, SplitViewOrientation, SplitViewPanel, SplitViewSeparator } from '@/components/split-view'
import { Button } from '@/components/ui/button'
import { FileDiffPath } from '@/components/ui/file-diff-list'
import { PopoverSurface } from '@/components/ui/popover-surface'
import { groupBy } from '@/lib/group'
import { useElementWidth } from '@/lib/use-element-width'

import { ContentPane } from './content-pane'
import { ChangedFilesTree } from './file-tree'

/** Where the explorer should land: a file, and optionally a comment inside it to scroll to. */
export interface ExplorerFocus {
  path: string
  commentId?: string
}

/** Tree beside the content, tree above it, or tree in a popover — chosen from the container width. */
type Arrangement = 'side' | 'stacked' | 'overlay'

const BREAKPOINTS: ReadonlyArray<[minWidth: number, arrangement: Arrangement]> = [
  [680, 'side'],
  [480, 'stacked'],
  [0, 'overlay']
]
const arrangementFor = (width: number): Arrangement => (BREAKPOINTS.find(([min]) => width >= min) as [number, Arrangement])[1]

const SPLIT: Record<Exclude<Arrangement, 'overlay'>, SplitViewOrientation> = {
  side: SplitViewOrientation.Horizontal,
  stacked: SplitViewOrientation.Vertical
}

/** Narrow layouts: the tree opens from a button and closes on a tap outside or a pick. */
function TreePopover({ tree, selectedPath }: { tree: React.ReactNode; selectedPath?: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border bg-muted/30 px-2 py-1">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <Button variant="ghost" size="icon" className="size-7" aria-label="Changed files" aria-expanded={open}>
            <FolderTree className="size-4" />
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content asChild side="bottom" align="start" sideOffset={6} collisionPadding={8} onClick={() => setOpen(false)}>
            <PopoverSurface className="h-[60vh] w-[min(92vw,22rem)] overflow-hidden p-0">{tree}</PopoverSurface>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {selectedPath ? <FileDiffPath path={selectedPath} className="min-w-0 flex-1 font-mono text-xs" /> : null}
    </div>
  )
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
  className
}: {
  worktreeId: string
  spec: DiffSpec
  files: ChangedFile[]
  comments: ReviewComment[]
  mode: DiffMode
  focus?: ExplorerFocus
  className?: string
}): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null)
  const arrangement = arrangementFor(useElementWidth(container))
  const [picked, setPicked] = useState<string>()
  useEffect(() => setPicked(focus?.path), [focus])
  const selectedPath = picked ?? files[0]?.path
  const selected = files.find((f) => f.path === selectedPath)
  const byFile = useMemo(() => groupBy(comments, (c) => c.file), [comments])
  const counts = useMemo(() => new Map([...byFile].map(([file, list]) => [file, list.length])), [byFile])

  const tree = <ChangedFilesTree files={files} commentCounts={counts} selected={selectedPath} onSelect={setPicked} className="h-full" />
  const content = selected ? (
    <ContentPane
      key={selected.path}
      worktreeId={worktreeId}
      spec={spec}
      file={selected}
      comments={byFile.get(selected.path) ?? []}
      mode={mode}
      focusCommentId={focus?.path === selected.path ? focus.commentId : undefined}
    />
  ) : null

  return (
    <div ref={container} className={className}>
      {arrangement === 'overlay' ? (
        <div className="flex h-full min-h-0 flex-col">
          <TreePopover tree={tree} selectedPath={selectedPath} />
          <div className="min-h-0 flex-1">{content}</div>
        </div>
      ) : (
        <SplitView orientation={SPLIT[arrangement]} className="h-full">
          <SplitViewPanel id="files" defaultSize={30} minSize={18} className="min-h-0 border-r border-border bg-card">
            {tree}
          </SplitViewPanel>
          <SplitViewSeparator />
          <SplitViewPanel id="content" minSize={40} className="min-h-0">
            {content}
          </SplitViewPanel>
        </SplitView>
      )}
    </div>
  )
}
