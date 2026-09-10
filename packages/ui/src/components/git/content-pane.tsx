import { useState } from 'react'
import { ArrowLeft } from 'lucide-react'

import type { ChangedFile, DiffSpec, ReviewComment } from '@canopy/shared'

import { WorktreeDiff, type DiffMode } from '@/components/worktree-diff'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DiffStat, FileDiffPath } from '@/components/ui/file-diff-list'
import { SegmentedControl, SegmentedControlOption } from '@/components/ui/segmented-control'
import { useFilePatch } from '@/lib/api-hooks'
import { isMarkdownPath } from '@/lib/language'
import { FILE_STATUS_LABEL } from '@/lib/status'

import { FileViewer, MarkdownPreview, type OpenPath } from './file-viewer'
import { HunkCards } from './hunk-cards'

type View = 'diff' | 'hunks' | 'file' | 'preview'

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

/** Which blob the non-diff views read: the commit's copy, or the working tree's. */
const revOf = (spec: DiffSpec): string | undefined => (spec.kind === 'commit' ? spec.sha : undefined)

/** Each view is one component; the toggle just picks the row of this table. */
const BODY: Record<View, (props: Props) => React.JSX.Element> = {
  diff: DiffBody,
  hunks: HunksBody,
  file: ({ worktreeId, spec, file }) => <FileViewer worktreeId={worktreeId} path={file.path} rev={revOf(spec)} />,
  preview: ({ worktreeId, spec, file, anchor, onOpenPath }) => (
    <MarkdownPreview worktreeId={worktreeId} path={file.path} rev={revOf(spec)} anchor={anchor} onOpenPath={onOpenPath} />
  )
}

/** The header every pane shares: where you came from, which file this is, and how to read it. */
function PaneHeader({ path, onBack, children }: { path: string; onBack?: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-muted/30 px-3 py-2">
      {onBack ? (
        <Button variant="ghost" size="icon" className="size-6 shrink-0" aria-label="Back to the previous file" onClick={onBack}>
          <ArrowLeft className="size-3.5" />
        </Button>
      ) : null}
      <FileDiffPath path={path} className="min-w-0 flex-1 font-mono text-xs" />
      {children}
    </div>
  )
}

/** The right-hand pane of the explorer: one file, as its diff, its full contents, or — for markdown — rendered. */
export function ContentPane(props: Props): React.JSX.Element {
  const [picked, setPicked] = useState<View>()
  const { file, onBack, canPickHunks } = props
  const canView = file.status !== 'D'
  const canPreview = canView && isMarkdownPath(file.path)
  // A binary file has no hunks, and a conflicted one must be resolved before any of it is staged.
  const canHunks = Boolean(canPickHunks) && !file.binary && !file.conflicted
  // Markdown opens rendered — the diff of a doc is a click away, but prose is what it is for.
  // Everything else opens as its diff, and a deleted file has no blob to render either way.
  const view = picked ?? (canPreview ? 'preview' : 'diff')
  const resolved: View = (view === 'preview' && !canPreview) || (view === 'hunks' && !canHunks) ? 'diff' : view
  const Body = BODY[resolved]

  return (
    <div className="flex h-full min-h-0 flex-col">
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
          {canPreview ? <SegmentedControlOption value="preview">Preview</SegmentedControlOption> : null}
        </SegmentedControl>
      </PaneHeader>
      <div className="min-h-0 flex-1 overflow-auto">
        <Body key={`${resolved}:${file.path}`} {...props} />
      </div>
    </div>
  )
}

/**
 * One file read outside a diff: rendered prose when it is markdown, otherwise its source, with
 * the same header nav the diff pane has. Links inside a rendered doc keep the trail going.
 */
export function FilePane({ worktreeId, path, rev, badge, actions, className, anchor, onOpenPath, onBack }: {
  worktreeId: string
  path: string
  rev?: string
  badge?: string
  /** Chrome the host puts at the end of the header — the pane's own split, maximize and close. */
  actions?: React.ReactNode
  className?: string
} & Navigation): React.JSX.Element {
  const [picked, setPicked] = useState<Exclude<View, 'diff'>>()
  const canPreview = isMarkdownPath(path)
  // Markdown opens rendered, the way it opens in the diff pane; anything else has only source.
  const view: Exclude<View, 'diff'> = picked === 'file' || !canPreview ? 'file' : 'preview'

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <PaneHeader path={path} onBack={onBack}>
        {badge ? (
          <Badge variant="outline" className="text-[10px]">
            {badge}
          </Badge>
        ) : null}
        {canPreview ? (
          <SegmentedControl value={view} onValueChange={(value) => setPicked(value as Exclude<View, 'diff'>)} aria-label="Content view">
            <SegmentedControlOption value="file">File</SegmentedControlOption>
            <SegmentedControlOption value="preview">Preview</SegmentedControlOption>
          </SegmentedControl>
        ) : null}
        {actions}
      </PaneHeader>
      <div className="min-h-0 flex-1 overflow-auto">
        {view === 'preview' ? (
          <MarkdownPreview key={path} worktreeId={worktreeId} path={path} rev={rev} anchor={anchor} onOpenPath={onOpenPath} />
        ) : (
          <FileViewer key={path} worktreeId={worktreeId} path={path} rev={rev} />
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
