import { useEffect, useState } from 'react'
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
import type { LineRange } from '@/lib/file-refs'
import { isImagePath, isMarkdownPath, isSvgPath } from '@/lib/language'
import { lineAt, slicePatch } from '@/lib/patch'
import { fileWindowHash } from '@/lib/pop-out'
import { usePlatform } from '@/providers/platform'
import { FILE_STATUS_LABEL } from '@/lib/status'

import { FileViewer, MarkdownDiff, MarkdownPreview, type OpenPath } from './file-viewer'
import { HunkCards } from './hunk-cards'
import { ImageDiff, ImagePreview } from './image-viewer'

type View = 'diff' | 'hunks' | 'file'

/** What a file shows instead of its source: prose for markdown, the picture for an image, or nothing but the source. */
type Rendering = 'markdown' | 'image' | false

/** How a path reads when it is not shown as source. */
const renderingOf = (path: string): Rendering => (isMarkdownPath(path) ? 'markdown' : isImagePath(path) ? 'image' : false)

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
  /** Lines to land on: highlighted in the diff, or found in the whole file when no hunk shows them. */
  focusLines?: LineRange
  /** Offer hunk picking. Only the commit panel does: it is the only view with an index to stage into. */
  canPickHunks?: boolean
  /** Only these hunks in the diff — one Groups section's share of the file. The whole-file view still shows every change. */
  hunks?: number[]
}

/** Why a patch has no text to show: binary, past the cap, or — once the change is committed — no difference left. */
const emptyPatchNote = ({ binary, truncated }: { binary: boolean; truncated: boolean }): string =>
  binary ? 'Binary file.' : truncated ? 'Diff too large to display (over 512 KiB).' : 'No changes to this file.'

/** Both diff views need the same patch and the same "there is nothing to show" answers. */
function WithPatch({ worktreeId, spec, file, hunks, children }: Pick<Props, 'worktreeId' | 'spec' | 'file' | 'hunks'> & { children: (patch: string) => React.JSX.Element }): React.JSX.Element {
  const patch = useFilePatch(worktreeId, spec, file.path, true)
  if (patch.isPending) return <p className="p-3 font-mono text-[11px] text-muted-foreground">Loading diff…</p>
  if (patch.error) return <p className="p-3 text-xs text-destructive">{patch.error.message}</p>
  if (!patch.data.patch) {
    return <p className="p-3 font-mono text-[11px] text-muted-foreground">{emptyPatchNote(patch.data)}</p>
  }
  return children(hunks ? slicePatch(patch.data.patch, hunks).patch : patch.data.patch)
}

function DiffBody({ worktreeId, spec, file, hunks, comments, mode, focusCommentId, focusLines }: Props): React.JSX.Element {
  return (
    <WithPatch worktreeId={worktreeId} spec={spec} file={file} hunks={hunks}>
      {(patch) => <WorktreeDiff worktreeId={worktreeId} spec={spec} path={file.path} patch={patch} comments={comments} mode={mode} focusCommentId={focusCommentId} focusLines={focusLines} />}
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
function RenderedDiffBody({ worktreeId, spec, file, hunks, onOpenPath }: Props): React.JSX.Element {
  return (
    <WithPatch worktreeId={worktreeId} spec={spec} file={file} hunks={hunks}>
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

/** Each view is one component; the tabs pick the row of this table, the rendering picks the column. */
const BODY: Record<View, (props: Props, rendering: Rendering) => React.JSX.Element> = {
  diff: (props, rendering) => (rendering === 'markdown' ? <RenderedDiffBody {...props} /> : rendering === 'image' ? <ImageDiff worktreeId={props.worktreeId} spec={props.spec} file={props.file} /> : <DiffBody {...props} />),
  hunks: (props) => <HunksBody {...props} />,
  file: (props, rendering) =>
    rendering === 'markdown' ? (
      <MarkdownPreview worktreeId={props.worktreeId} path={props.file.path} rev={revOf(props.spec)} anchor={props.anchor} onOpenPath={props.onOpenPath} />
    ) : rendering === 'image' ? (
      <ImagePreview worktreeId={props.worktreeId} path={props.file.path} rev={revOf(props.spec)} />
    ) : (
      <FileBody {...props} />
    )
}

/**
 * Markdown reads as prose everywhere it can — a rendered diff in the Diff tab, the rendered doc
 * in File — and this drops to the source of whichever one is showing. An SVG is the one image
 * with a source worth reading, so it gets the same toggle; every other file type only ever has
 * one form, and the toggle is not offered.
 */
function RawToggle({ raw, what, onToggle }: { raw: boolean; what: 'markdown' | 'image'; onToggle: () => void }): React.JSX.Element {
  return (
    <IconAction label={raw ? `Show the rendered ${what}` : `Show the ${what === 'markdown' ? 'raw markdown' : 'svg source'}`} pressed={raw} onClick={onToggle}>
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
  // Lines handed in from outside show where they are: in the diff when a hunk holds them, else in the file.
  const patch = useFilePatch(props.worktreeId, props.spec, file.path, props.focusLines !== undefined)
  const patchText = patch.data?.patch
  useEffect(() => {
    if (!props.focusLines || patchText === undefined) return
    setPicked(patchText && lineAt(patchText, 'new', props.focusLines.start) !== undefined ? 'diff' : 'file')
  }, [props.focusLines, patchText])
  const view = picked ?? 'diff'
  const resolved: View = (view === 'hunks' && !canHunks) || (view === 'file' && !canView) ? 'diff' : view
  // Hunk picking is line work by definition. A deleted doc has no blob left to render, but a
  // deleted image still has its before side to show, which is the whole diff.
  const kind = renderingOf(file.path)
  const rendering: Rendering = resolved === 'hunks' || (kind === 'markdown' && (!canView || file.binary)) ? false : kind
  // Only a form with a source behind it can be toggled to that source: prose, or an svg.
  const canToggle = rendering === 'markdown' || (rendering === 'image' && isSvgPath(file.path))
  const shown: Rendering = canToggle && raw ? false : rendering

  return (
    // A diagram in this file expands to fill the pane, not the window: the doc it belongs to
    // stays beside it, which is the whole reason to open the diagram at all.
    // `data-file-path` names the file for code selected or dragged out of it (see `snippetSource`).
    <div data-diagram-surface data-file-path={file.path} className="relative flex h-full min-h-0 flex-col">
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
        {canToggle ? <RawToggle raw={raw} what={rendering as 'markdown' | 'image'} onToggle={() => setRaw(!raw)} /> : null}
      </PaneHeader>
      <div key={`${resolved}:${shown}:${file.path}`} className="min-h-0 flex-1 overflow-auto">
        {BODY[resolved](props, shown)}
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
  // Markdown opens rendered and an image shown, the way they open in the diff pane; anything else has only source.
  const kind = renderingOf(path)
  const canToggle = kind === 'markdown' || (kind === 'image' && isSvgPath(path))
  const shown: Rendering = canToggle && raw ? false : kind

  return (
    <div data-diagram-surface data-file-path={path} className={cn('relative flex h-full min-h-0 flex-col', className)}>
      <PaneHeader path={path} dragPaneId={dragPaneId} onBack={onBack}>
        {badge ? (
          <Badge variant="outline" className="text-[10px]">
            {badge}
          </Badge>
        ) : null}
        {canToggle ? <RawToggle raw={raw} what={kind as 'markdown' | 'image'} onToggle={() => setRaw(!raw)} /> : null}
        <OpenInWindow worktreeId={worktreeId} path={path} rev={rev} />
        {actions}
      </PaneHeader>
      <div className="min-h-0 flex-1 overflow-auto">
        {shown === 'markdown' ? (
          <MarkdownPreview key={path} worktreeId={worktreeId} path={path} rev={rev} anchor={anchor} onOpenPath={onOpenPath} />
        ) : shown === 'image' ? (
          <ImagePreview key={path} worktreeId={worktreeId} path={path} rev={rev} />
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
