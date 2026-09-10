import { useMemo, useState } from 'react'

import type { ChangedFile } from '@canopy/shared'

import { Badge } from '@/components/ui/badge'
import { DiffStat } from '@/components/ui/file-diff-list'
import { FileIcon } from '@/components/ui/file-icon'
import { TreeView, type TreeViewNode } from '@/components/ui/tree-view'
import { useTrees } from '@/lib/api-hooks'
import { defaultOpenDirs, dirTotals, emptyDir, flattenTree, toggled, treeFromPaths, withListing, type FlatRow, type TreeDir } from '@/lib/file-tree'
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

/** The trailing columns of a changed-files row: comments, +/- and one narrow slot that keeps them aligned. */
const RowMeta = ({ comments, additions, deletions, commentTitle, trailing, trailingTitle }: {
  comments: number
  additions: number
  deletions: number
  commentTitle: string
  trailing: React.ReactNode
  trailingTitle?: string
}): React.JSX.Element => (
  <span className="flex items-center gap-1.5 font-mono text-[10px]">
    {comments > 0 ? <Badge variant="secondary" className="px-1 text-[9px]" title={commentTitle}>{comments}</Badge> : null}
    <DiffStat additions={additions} deletions={deletions} className="text-[10px]" />
    <span className="min-w-3 text-center text-muted-foreground" title={trailingTitle}>{trailing}</span>
  </span>
)

/**
 * Changed files as a tree, open by default except hidden folders; file rows carry status,
 * comment count and stat, and a collapsed folder carries the same totals for everything
 * hidden inside it. Open folders stay bare — their own rows already show the numbers.
 */
export function ChangedFilesTree({ files, commentCounts, ...props }: TreeProps & { files: ChangedFile[]; commentCounts: ReadonlyMap<string, number> }): React.JSX.Element {
  const root = useMemo(() => treeFromPaths(files.map((f) => f.path)), [files])
  const byPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files])
  const { expanded, toggle } = useExpanded(() => defaultOpenDirs(root))
  const totals = useMemo(
    () =>
      dirTotals(root, (path) => {
        const file = byPath.get(path)
        return { additions: file?.additions ?? 0, deletions: file?.deletions ?? 0, comments: commentCounts.get(path) ?? 0 }
      }),
    [root, byPath, commentCounts]
  )
  const meta = useMemo(
    () => (row: FlatRow) => {
      if (row.kind === 'dir') {
        const total = row.expanded ? undefined : totals.get(row.id)
        if (!total) return null
        return (
          <RowMeta
            comments={total.comments}
            additions={total.additions}
            deletions={total.deletions}
            commentTitle={plural(total.comments, 'comment')}
            trailing={total.files}
            trailingTitle={plural(total.files, 'changed file')}
          />
        )
      }
      const file = byPath.get(row.id)
      if (!file) return null
      const comments = commentCounts.get(row.id) ?? 0
      return (
        <RowMeta
          comments={comments}
          additions={file.additions}
          deletions={file.deletions}
          commentTitle={plural(comments, 'comment')}
          trailing={file.status}
        />
      )
    },
    [byPath, commentCounts, totals]
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
