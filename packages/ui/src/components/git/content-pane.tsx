import { useState } from 'react'
import { ArrowLeft, Code2, Eye, GripVertical, SquareArrowOutUpRight } from 'lucide-react'

import type { ChangedFile, DiffSpec, ReviewComment } from '@canopy/shared'

import { AppShellPaneDragHandle } from '@/components/composites/app-shell'
import { WorktreeDiff, type DiffMode } from '@/components/worktree-diff'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { IconAction } from '@/components/icon-action'
import { Button } from '@/components/ui/button'
import { DiffStat, FileDiffPath } from '@/components/ui/file-diff-list'
import { SegmentedControl, SegmentedControlOption } from '@/components/ui/segmented-control'
import { useFilePatch } from '@/lib/api-hooks'
import { isMarkdownPath } from '@/lib/language'
import { fileWindowHash } from '@/lib/pop-out'
import { usePlatform } from '@/providers/platform'
import { FILE_STATUS_LABEL } from '@/lib/status'

import { FileViewer, MarkdownDiff, MarkdownPreview, type OpenPath } from './file-viewer'
import { HunkCards } from './hunk-cards'

type View = 'diff' | 'hunks' | 'file'

/** How a pane was reached, and where its own links lead: shared by the changed-file and loose panes. */
interface Navigation {
  /** A heading to scroll to, carried in from the link that opened this file. */
  anchor?: string
  /** Follow a link out of this file, to whatever path it resolves to in the worktree. */
  onOpenPath?: OpenPath
  /** Return to the file this one was opened from; absent at the start of a trail. */
  onBack?: () => void
}

interface Props extends Navigation {
  worktreeId: string
  spec: DiffSpec
  file: ChangedFile
  comments: ReviewComment[]
  mode: DiffMode
  focusCommentId?: string
  /** Offer hunk picking. Only the commit panel does: it is the only view with an index to stage into. */
  canPickHunks?: boolean
}

/** Both diff views need the same patch and the same "there is nothing to show" answers. */
function WithPatch({ worktreeId, spec, file, children }: Pick<Props, 'worktreeId' | 'spec' | 'file'> & { children: (patch: string) => React.JSX.Element }): React.JSX.Element {
  const patch = useFilePatch(worktreeId, spec, file.path, true)
  if (patch.isPending) return <p className="p-3 font-mono text-[11px] text-muted-foreground">Loading diff…</p>
  if (patch.error) return <p className="p-3 text-xs text-destructive">{patch.error.message}</p>
  if (!patch.data.patch) {
    return <p className="p-3 font-mono text-[11px] text-muted-foreground">{patch.data.binary ? 'Binary file.' : 'Diff too large to display (over 512 KiB).'}</p>
  }
  return children(patch.data.patch)
}

function DiffBody({ worktreeId, spec, file, comments, mode, focusCommentId }: Props): React.JSX.Element {
  return (
    <WithPatch worktreeId={worktreeId} spec={spec} file={file}>
      {(patch) => <WorktreeDiff worktreeId={worktreeId} spec={spec} path={file.path} patch={patch} comments={comments} mode={mode} focusCommentId={focusCommentId} />}
    </WithPatch>
  )
}

function HunksBody({ worktreeId, spec, file, comments, mode }: Props): React.JSX.Element {
  return (
    <WithPatch worktreeId={worktreeId} spec={spec} file={file}>
      {(patch) => <HunkCards worktreeId={worktreeId} spec={spec} file={file} patch={patch} comments={comments} mode={mode} />}
    </WithPatch>
  )
}

/**
 * Which blob the non-diff views read: the commit's copy, the after side of a two-tree diff (a PR
 * head, an agent snapshot), or the working tree's. Whatever the kind, it is the side the patch
 * was made against, so the marks always land on the lines they describe.
 */
const revOf = (spec: DiffSpec): string | undefined => (spec.kind === 'commit' ? spec.sha : spec.kind === 'trees' ? spec.after : undefined)

/** The rendered diff: the doc as prose, with the change marked on it. Markdown only. */
function RenderedDiffBody({ worktreeId, spec, file, onOpenPath }: Props): React.JSX.Element {
  return (
    <WithPatch worktreeId={worktreeId} spec={spec} file={file}>
      {(patch) => <MarkdownDiff worktreeId={worktreeId} path={file.path} rev={revOf(spec)} patch={patch} onOpenPath={onOpenPath} />}
    </WithPatch>
  )
}

/**
 * The whole file, with the change marked on its lines. The file shows as soon as it is read; the
 * marks follow once the patch is in, so a slow diff never holds the file back.
 */
function FileBody({ worktreeId, spec, file, anchor, onOpenPath }: Props): React.JSX.Element {
  const patch = useFilePatch(worktreeId, spec, file.path, true)
  return <FileViewer worktreeId={worktreeId} path={file.path} rev={revOf(spec)} anchor={anchor} patch={patch.data?.patch ?? undefined} onOpenPath={onOpenPath} />
}

/** Each view is one component; the tabs pick the row of this table, the toggle picks the column. */
const BODY: Record<View, (props: Props, rendered: boolean) => React.JSX.Element> = {
  diff: (props, rendered) => (rendered ? <RenderedDiffBody {...props} /> : <DiffBody {...props} />),
  hunks: (props) => <HunksBody {...props} />,
  file: (props, rendered) =>
    rendered ? <MarkdownPreview worktreeId={props.worktreeId} path={props.file.path} rev={revOf(props.spec)} anchor={props.anchor} onOpenPath={props.onOpenPath} /> : <FileBody {...props} />
}

/**
 * Markdown reads as prose everywhere it can — a rendered diff in the Diff tab, the rendered doc
 * in File — and this drops to the source of whichever one is showing. Every other file type only
 * ever has source, so the toggle is not offered.
 */
function RawToggle({ raw, onToggle }: { raw: boolean; onToggle: () => void }): React.JSX.Element {
  return (
    <IconAction label={raw ? 'Show the rendered markdown' : 'Show the raw markdown'} pressed={raw} onClick={onToggle}>
      {raw ? <Eye aria-hidden className="size-3.5" /> : <Code2 aria-hidden className="size-3.5" />}
    </IconAction>
  )
}

/** Pulls this file out into a window of its own, to read beside the one it was opened from. */
function OpenInWindow({ worktreeId, path, rev }: { worktreeId: string; path: string; rev?: string }): React.JSX.Element {
  const { openWindow } = usePlatform()
  return (
    <IconAction label="Open this file in a new window" onClick={() => openWindow(fileWindowHash(worktreeId, path, rev))}>
      <SquareArrowOutUpRight aria-hidden className="size-3.5" />
    </IconAction>
  )
}

/**
 * The header every pane shares: where you came from, which file this is, and how to read it.
 * Inside a workspace, `dragPaneId` turns the path into the pane's grip — press it and drag onto
 * another pane to trade places. It is only ever passed by a pane rendered in an AppShell.
 */
function PaneHeader({ path, dragPaneId, onBack, children }: { path: string; dragPaneId?: string; onBack?: () => void; children: React.ReactNode }): React.JSX.Element {
  const label = <FileDiffPath path={path} className="min-w-0 flex-1 font-mono text-xs" />
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-muted/30 px-3 py-2">
      {onBack ? (
        <Button variant="ghost" size="icon" className="size-6 shrink-0" aria-label="Back to the previous file" onClick={onBack}>
          <ArrowLeft className="size-3.5" />
        </Button>
      ) : null}
      {dragPaneId === undefined ? (
        label
      ) : (
        <AppShellPaneDragHandle paneId={dragPaneId} className="flex min-w-0 flex-1 items-center gap-1.5" title="Drag this file onto another pane to swap them">
          <GripVertical aria-hidden className="size-3 shrink-0 text-muted-foreground/60" />
          {label}
        </AppShellPaneDragHandle>
      )}
      {children}
    </div>
  )
}

/** The right-hand pane of the explorer: one file, as its diff, its hunks, or its whole contents. */
export function ContentPane(props: Props): React.JSX.Element {
  const [picked, setPicked] = useState<View>()
  const [raw, setRaw] = useState(false)
  const { file, onBack, canPickHunks } = props
  const canView = file.status !== 'D'
  // A binary file has no hunks, and a conflicted one must be resolved before any of it is staged.
  const canHunks = Boolean(canPickHunks) && !file.binary && !file.conflicted
  const view = picked ?? 'diff'
  const resolved: View = (view === 'hunks' && !canHunks) || (view === 'file' && !canView) ? 'diff' : view
  // A deleted file has no blob left to render, and hunk picking is line work by definition.
  const markdown = canView && !file.binary && isMarkdownPath(file.path)
  const canRender = markdown && resolved !== 'hunks'

  return (
    // A diagram in this file expands to fill the pane, not the window: the doc it belongs to
    // stays beside it, which is the whole reason to open the diagram at all.
    <div data-diagram-surface className="relative flex h-full min-h-0 flex-col">
      <PaneHeader path={file.path} onBack={onBack}>
        <Badge variant="outline" className="text-[10px]">
          {FILE_STATUS_LABEL[file.status]}
        </Badge>
        {file.binary ? <span className="font-mono text-[11px] text-muted-foreground">binary</span> : <DiffStat additions={file.additions} deletions={file.deletions} className="text-[11px]" />}
        <SegmentedControl value={resolved} onValueChange={(value) => setPicked(value as View)} aria-label="Content view">
          <SegmentedControlOption value="diff">Diff</SegmentedControlOption>
          {canHunks ? <SegmentedControlOption value="hunks">Hunks</SegmentedControlOption> : null}
          <SegmentedControlOption value="file" disabled={!canView}>
            File
          </SegmentedControlOption>
        </SegmentedControl>
        {canRender ? <RawToggle raw={raw} onToggle={() => setRaw(!raw)} /> : null}
      </PaneHeader>
      <div key={`${resolved}:${canRender && !raw}:${file.path}`} className="min-h-0 flex-1 overflow-auto">
        {BODY[resolved](props, canRender && !raw)}
      </div>
    </div>
  )
}

/**
 * One file read outside a diff: rendered prose when it is markdown, otherwise its source, with
 * the same header nav the diff pane has. Links inside a rendered doc keep the trail going.
 */
export function FilePane({ worktreeId, path, rev, badge, actions, className, dragPaneId, anchor, onOpenPath, onBack }: {
  worktreeId: string
  path: string
  rev?: string
  badge?: string
  /** Chrome the host puts at the end of the header — the pane's own split, maximize and close. */
  actions?: React.ReactNode
  className?: string
  /** The workspace pane this file sits in; given, its header doubles as the pane's drag grip. */
  dragPaneId?: string
} & Navigation): React.JSX.Element {
  const [raw, setRaw] = useState(false)
  // Markdown opens rendered, the way it opens in the diff pane; anything else has only source.
  const markdown = isMarkdownPath(path)
  const rendered = markdown && !raw

  return (
    <div data-diagram-surface className={cn('relative flex h-full min-h-0 flex-col', className)}>
      <PaneHeader path={path} dragPaneId={dragPaneId} onBack={onBack}>
        {badge ? (
          <Badge variant="outline" className="text-[10px]">
            {badge}
          </Badge>
        ) : null}
        {markdown ? <RawToggle raw={raw} onToggle={() => setRaw(!raw)} /> : null}
        <OpenInWindow worktreeId={worktreeId} path={path} rev={rev} />
        {actions}
      </PaneHeader>
      <div className="min-h-0 flex-1 overflow-auto">
        {rendered ? (
          <MarkdownPreview key={path} worktreeId={worktreeId} path={path} rev={rev} anchor={anchor} onOpenPath={onOpenPath} />
        ) : (
          <FileViewer key={path} worktreeId={worktreeId} path={path} rev={rev} anchor={anchor} onOpenPath={onOpenPath} />
        )}
      </div>
    </div>
  )
}

/**
 * A file the change set does not contain, reached by following a link out of a rendered doc —
 * a spec pointing at the module it describes, a README pointing at a sibling doc. It has no
 * diff to show, so it reads as prose or as source, and its own links keep the trail going.
 */
export function LooseFilePane({ worktreeId, spec, path, ...nav }: { worktreeId: string; spec: DiffSpec; path: string } & Navigation): React.JSX.Element {
  return <FilePane worktreeId={worktreeId} path={path} rev={revOf(spec)} badge="Unchanged" {...nav} />
}
