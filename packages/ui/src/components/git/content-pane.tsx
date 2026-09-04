import { useState } from 'react'

import type { ChangedFile, DiffSpec, ReviewComment } from '@canopy/shared'

import { WorktreeDiff, type DiffMode } from '@/components/worktree-diff'
import { Badge } from '@/components/ui/badge'
import { DiffStat, FileDiffPath } from '@/components/ui/file-diff-list'
import { SegmentedControl, SegmentedControlOption } from '@/components/ui/segmented-control'
import { useFilePatch } from '@/lib/api-hooks'
import { FILE_STATUS_LABEL } from '@/lib/status'

import { FileViewer } from './file-viewer'

type View = 'diff' | 'file'

interface Props {
  worktreeId: string
  spec: DiffSpec
  file: ChangedFile
  comments: ReviewComment[]
  mode: DiffMode
  focusCommentId?: string
}

function DiffBody({ worktreeId, spec, file, comments, mode, focusCommentId }: Props): React.JSX.Element {
  const patch = useFilePatch(worktreeId, spec, file.path, true)
  if (patch.isPending) return <p className="p-3 font-mono text-[11px] text-muted-foreground">Loading diff…</p>
  if (patch.error) return <p className="p-3 text-xs text-destructive">{patch.error.message}</p>
  if (!patch.data.patch) {
    return <p className="p-3 font-mono text-[11px] text-muted-foreground">{patch.data.binary ? 'Binary file.' : 'Diff too large to display (over 512 KiB).'}</p>
  }
  return <WorktreeDiff worktreeId={worktreeId} spec={spec} path={file.path} patch={patch.data.patch} comments={comments} mode={mode} focusCommentId={focusCommentId} />
}

/** Each view is one component; the toggle just picks the row of this table. */
const BODY: Record<View, (props: Props) => React.JSX.Element> = {
  diff: DiffBody,
  file: ({ worktreeId, spec, file }) => <FileViewer worktreeId={worktreeId} path={file.path} rev={spec.kind === 'commit' ? spec.sha : undefined} />
}

/** The right-hand pane of the explorer: one file, as its diff or its full contents. */
export function ContentPane(props: Props): React.JSX.Element {
  const [view, setView] = useState<View>('diff')
  const { file } = props
  const Body = BODY[view]
  const canView = file.status !== 'D'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-muted/30 px-3 py-2">
        <FileDiffPath path={file.path} className="min-w-0 flex-1 font-mono text-xs" />
        <Badge variant="outline" className="text-[10px]">
          {FILE_STATUS_LABEL[file.status]}
        </Badge>
        {file.binary ? <span className="font-mono text-[11px] text-muted-foreground">binary</span> : <DiffStat additions={file.additions} deletions={file.deletions} className="text-[11px]" />}
        <SegmentedControl value={view} onValueChange={(value) => setView(value as View)} aria-label="Content view">
          <SegmentedControlOption value="diff">Diff</SegmentedControlOption>
          <SegmentedControlOption value="file" disabled={!canView}>
            File
          </SegmentedControlOption>
        </SegmentedControl>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <Body key={`${view}:${file.path}`} {...props} />
      </div>
    </div>
  )
}
