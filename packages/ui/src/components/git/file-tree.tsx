import { useMemo, useState } from 'react'

import type { ChangedFile } from '@canopy/shared'

import { Badge } from '@/components/ui/badge'
import { DiffStat } from '@/components/ui/file-diff-list'
import { FileIcon } from '@/components/ui/file-icon'
import { TreeView, type TreeViewNode } from '@/components/ui/tree-view'
import { useTrees } from '@/lib/api-hooks'
import { allDirs, emptyDir, flattenTree, toggled, treeFromPaths, withListing, type FlatRow, type TreeDir } from '@/lib/file-tree'
import { plural } from '@/lib/format'

interface TreeProps {
  selected?: string
  onSelect: (path: string) => void
  className?: string
}

/** Expansion state shared by both trees: a set of open directory paths. */
function useExpanded(initial: () => Iterable<string>) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(initial()))
  return { expanded, toggle: (path: string) => setExpanded((current) => toggled(current, path)) }
}

/** Icon plus name, the way editors draw a file row. */
const RowLabel = ({ row }: { row: FlatRow }): React.JSX.Element => (
  <span className="flex min-w-0 items-center gap-1.5">
    <FileIcon name={row.name} kind={row.kind} expanded={row.expanded} className="size-3.5" />
    <span className="truncate">{row.name}</span>
  </span>
)

/** The one TreeView wiring; the two trees differ only in where rows and row metadata come from. */
function Tree({ root, expanded, toggle, meta, label, selected, onSelect, className }: TreeProps & {
  root: TreeDir
  expanded: ReadonlySet<string>
  toggle: (path: string) => void
  label: string
  meta?: (row: FlatRow) => React.ReactNode
}): React.JSX.Element {
  const nodes = useMemo<TreeViewNode[]>(
    () => flattenTree(root, expanded).map((row) => ({ ...row, label: <RowLabel row={row} />, meta: meta?.(row) })),
    [root, expanded, meta]
  )
  return (
    <TreeView
      nodes={nodes}
      selectedId={selected}
      onSelect={(node) => onSelect(node.id)}
      onToggle={(node) => toggle(node.id)}
      label={label}
      className={className}
      emptyMessage="No files"
    />
  )
}

/** Changed files as a tree, fully open by default; rows carry status, comment count and stat. */
export function ChangedFilesTree({ files, commentCounts, ...props }: TreeProps & { files: ChangedFile[]; commentCounts: ReadonlyMap<string, number> }): React.JSX.Element {
  const root = useMemo(() => treeFromPaths(files.map((f) => f.path)), [files])
  const byPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files])
  const { expanded, toggle } = useExpanded(() => allDirs(root))
  const meta = useMemo(
    () => (row: FlatRow) => {
      const file = byPath.get(row.id)
      if (!file) return null
      const comments = commentCounts.get(row.id) ?? 0
      return (
        <span className="flex items-center gap-1.5 font-mono text-[10px]">
          {comments > 0 ? <Badge variant="secondary" className="px-1 text-[9px]" title={plural(comments, 'comment')}>{comments}</Badge> : null}
          <DiffStat additions={file.additions} deletions={file.deletions} className="text-[10px]" />
          <span className="w-3 text-center text-muted-foreground">{file.status}</span>
        </span>
      )
    },
    [byPath, commentCounts]
  )
  return <Tree root={root} expanded={expanded} toggle={toggle} meta={meta} label="Changed files" {...props} />
}

/** The whole worktree, one directory listing per open folder, fetched on demand. */
export function WorktreeTree({ worktreeId, ...props }: TreeProps & { worktreeId: string }): React.JSX.Element {
  const { expanded, toggle } = useExpanded(() => [])
  const dirs = useMemo(() => ['', ...expanded], [expanded])
  const listings = useTrees(worktreeId, dirs)
  const root = useMemo(
    () => listings.reduce((tree, query) => (query.data ? withListing(tree, query.data.path, query.data.entries) : tree), emptyDir()),
    // Listings settle independently; re-fold when any of them changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [listings.map((q) => q.data)]
  )
  return <Tree root={root} expanded={expanded} toggle={toggle} label="Worktree files" {...props} />
}
