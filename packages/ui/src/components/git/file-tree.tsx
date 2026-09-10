import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { ChangedFile } from '@canopy/shared'

import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DiffStat } from '@/components/ui/file-diff-list'
import { FileIcon } from '@/components/ui/file-icon'
import { TreeView, type TreeViewNode } from '@/components/ui/tree-view'
import { usePrefetchFileContents, useTrees, useWorktreeFiles } from '@/lib/api-hooks'
import type { CheckState } from '@/lib/commit-selection'
import { defaultOpenDirs, dirTotals, emptyDir, flattenTree, toggled, treeFromPaths, withListing, type FlatRow, type TreeDir } from '@/lib/file-tree'
import { useHoverPrefetch } from '@/lib/use-hover-prefetch'
import { readStored, writeStored } from '@/lib/local-store'
import { plural } from '@/lib/format'

interface TreeProps {
  selected?: string
  onSelect: (path: string) => void
  /** The file row under the pointer, as it moves — for reading a file before it is clicked. */
  onHover?: (path: string) => void
  className?: string
}

/**
 * Everything the commit panel adds to a changed-files tree. Optional, because the same tree also
 * renders a commit's files and an agent turn's files, where there is no index to check against.
 */
export interface CommitSelection {
  stateOf: (row: FlatRow) => CheckState
  /** A checkbox was clicked: the file paths it covers, and what it should become. */
  onToggle: (paths: string[], checked: boolean) => void
  /** The mouse-highlighted rows, which is a different thing from the row whose diff is showing. */
  highlighted: ReadonlySet<string>
  onHighlightChange: (highlighted: Set<string>, anchor: string) => void
  anchor: string | undefined
  /** The file paths a row acts on; a directory row expands to everything beneath it. */
  pathsFor: (row: FlatRow) => string[]
  /** Menu body for the paths a right-click targets. */
  renderMenu: (paths: string[]) => React.ReactNode
  disabled: boolean
}

/** TreeView's own default. Row hit-testing is arithmetic on it, so it is pinned here explicitly. */
const ROW_HEIGHT = 28

/**
 * Expansion state shared by both trees: a set of open directory paths. Given a `storageKey` it
 * outlives the tree, so a browser that was closed and reopened comes back to the folders it was
 * walking rather than to the bare root.
 */
function useExpanded(initial: () => Iterable<string>, storageKey?: string) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(storageKey === undefined ? initial() : (readStored<string[]>(storageKey) ?? initial()))
  )
  useEffect(() => {
    if (storageKey !== undefined) writeStored(storageKey, [...expanded])
  }, [storageKey, expanded])
  return { expanded, toggle: (path: string) => setExpanded((current) => toggled(current, path)) }
}

/** Icon plus name, the way editors draw a file row. */
const RowLabel = ({ row }: { row: FlatRow }): React.JSX.Element => (
  <span className="flex min-w-0 items-center gap-1.5">
    <FileIcon name={row.name} kind={row.kind} expanded={row.expanded} className="size-3.5" />
    <span className="truncate">{row.name}</span>
  </span>
)

/**
 * The checkbox on a commit-panel row. It carries `data-checkbox` because the pointer handling
 * lives on the scroll container (see `useRowPointers`) and that attribute is how a click on the
 * box is told apart from a click on the row. `tabIndex={-1}` keeps it out of the tab order,
 * which TreeView owns as a single roving tab stop across all rows.
 */
const RowCheckbox = ({ state, disabled }: { state: CheckState; disabled: boolean }): React.JSX.Element => (
  <span data-checkbox="" className="flex items-center pr-1.5">
    <Checkbox checked={state === 'checked'} indeterminate={state === 'mixed'} disabled={disabled} tabIndex={-1} readOnly className="size-3.5" />
  </span>
)

/**
 * Mouse selection for a virtualized tree, done from the scroll container rather than the rows.
 *
 * TreeView is vendored and must not be edited, and its `onSelect` hands back a node with no
 * event — so shift and ⌘ are simply not available through its API. Its container does receive
 * spread props though, and its rows are uniform and absolutely positioned, so the row under the
 * pointer is arithmetic: scroll offset plus cursor position over the row height. Going through
 * geometry rather than the DOM also means a drag keeps working over rows that windowing has not
 * mounted, and over the indent padding and the chevron.
 */
function useRowPointers(rows: readonly FlatRow[], commit: CommitSelection | undefined, onContextRow: (row: FlatRow) => void) {
  const drag = useRef<{ anchor: string; moved: boolean } | null>(null)
  // Pointerup clears the drag before the click arrives, so what the click must swallow is
  // decided while the pointer is still down and read back one event later.
  const swallow = useRef(false)

  const rowAt = useCallback(
    (container: HTMLElement, clientY: number): FlatRow | undefined => {
      const offset = container.scrollTop + clientY - container.getBoundingClientRect().top
      return rows[Math.floor(offset / ROW_HEIGHT)]
    },
    [rows]
  )

  if (!commit) return {}

  const select = (row: FlatRow, modifiers: { shift: boolean; meta: boolean }): void => {
    const next = new Set<string>()
    if (modifiers.shift && commit.anchor !== undefined) {
      const from = rows.findIndex((candidate) => candidate.id === commit.anchor)
      const to = rows.findIndex((candidate) => candidate.id === row.id)
      if (from !== -1 && to !== -1) for (const between of rows.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(between.id)
      if (modifiers.meta) for (const id of commit.highlighted) next.add(id)
      commit.onHighlightChange(next, commit.anchor)
      return
    }
    if (modifiers.meta) {
      for (const id of commit.highlighted) next.add(id)
      if (next.has(row.id)) next.delete(row.id)
      else next.add(row.id)
      commit.onHighlightChange(next, row.id)
      return
    }
    commit.onHighlightChange(new Set([row.id]), row.id)
  }

  return {
    onPointerDownCapture: (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      const row = rowAt(event.currentTarget, event.clientY)
      if (!row) return
      if ((event.target as HTMLElement).closest('[data-checkbox]')) {
        // Staging a file is not the same act as reading it: the box must not also move the
        // content pane, which would fetch and highlight a diff nobody asked for. The click
        // that follows this pointerdown is swallowed below for exactly that reason.
        event.preventDefault()
        event.stopPropagation()
        swallow.current = true
        if (!commit.disabled) commit.onToggle(commit.pathsFor(row), commit.stateOf(row) !== 'checked')
        return
      }
      drag.current = { anchor: row.id, moved: false }
      // A modified click extends the highlight; it must not also move the shown file.
      swallow.current = event.shiftKey || event.metaKey || event.ctrlKey
      select(row, { shift: event.shiftKey, meta: event.metaKey || event.ctrlKey })
      if (swallow.current) event.stopPropagation()
    },

    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
      if (!drag.current || event.buttons === 0) return
      const row = rowAt(event.currentTarget, event.clientY)
      if (!row || row.id === drag.current.anchor) return
      drag.current.moved = true
      const from = rows.findIndex((candidate) => candidate.id === drag.current?.anchor)
      const to = rows.findIndex((candidate) => candidate.id === row.id)
      if (from === -1 || to === -1) return
      const swept = rows.slice(Math.min(from, to), Math.max(from, to) + 1).map((candidate) => candidate.id)
      commit.onHighlightChange(new Set(swept), drag.current.anchor)
    },

    onPointerUp: () => {
      if (drag.current?.moved) swallow.current = true
      drag.current = null
    },

    onClickCapture: (event: React.MouseEvent<HTMLDivElement>) => {
      // The click that ends a drag, follows a checkbox, or carries a modifier has already been
      // acted on; letting it through would open the last row swept or the file just staged.
      if (!swallow.current) return
      swallow.current = false
      event.stopPropagation()
    },

    onContextMenuCapture: (event: React.MouseEvent<HTMLDivElement>) => {
      const row = rowAt(event.currentTarget, event.clientY)
      if (row) onContextRow(row)
    }
  }
}

/** The one TreeView wiring; the two trees differ only in where rows and row metadata come from. */
function Tree({ root, expanded, toggle, meta, label, selected, onSelect, onHover, className, commit }: TreeProps & {
  root: TreeDir
  expanded: ReadonlySet<string>
  toggle: (path: string) => void
  label: string
  meta?: (row: FlatRow) => React.ReactNode
  commit?: CommitSelection
}): React.JSX.Element {
  const rows = useMemo(() => flattenTree(root, expanded), [root, expanded])
  const [contextRow, setContextRow] = useState<FlatRow>()
  const pointers = useRowPointers(rows, commit, setContextRow)
  const handlers = onHover
    ? {
        ...pointers,
        onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
          pointers.onPointerMove?.(event)
          const container = event.currentTarget
          const row = rows[Math.floor((container.scrollTop + event.clientY - container.getBoundingClientRect().top) / ROW_HEIGHT)]
          if (row?.kind === 'file') onHover(row.id)
        }
      }
    : pointers

  const nodes = useMemo<TreeViewNode[]>(
    () =>
      rows.map((row) => ({
        ...row,
        label: (
          <span
            className={
              commit?.highlighted.has(row.id)
                ? 'flex min-w-0 flex-1 items-center rounded-sm bg-primary/8'
                : 'flex min-w-0 flex-1 items-center'
            }
          >
            {commit ? <RowCheckbox state={commit.stateOf(row)} disabled={commit.disabled} /> : null}
            <RowLabel row={row} />
          </span>
        ),
        meta: meta?.(row)
      })),
    [rows, meta, commit]
  )

  const tree = (
    <TreeView
      nodes={nodes}
      selectedId={selected}
      onSelect={(node) => onSelect(node.id)}
      onToggle={(node) => toggle(node.id)}
      label={label}
      rowHeight={ROW_HEIGHT}
      className={className}
      emptyMessage="No files"
      {...handlers}
    />
  )

  if (!commit) return tree
  return (
    <ContextMenu>
      {/*
        The trigger wraps the tree in a plain element rather than becoming it. `asChild` hands the
        child a ref, and TreeView spreads the props it is given straight onto its scroll container,
        after its own ref — so the ref it uses to measure the viewport would be overwritten, the
        measured height would stay 0, and it would mount `overscan` rows and nothing else.
      */}
      <ContextMenuTrigger asChild>
        <div className="h-full min-h-0">{tree}</div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-64">{contextRow ? commit.renderMenu(commit.pathsFor(contextRow)) : null}</ContextMenuContent>
    </ContextMenu>
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
 *
 * `commit` turns it into the commit panel's list: a checkbox per row and mouse selection. It is
 * optional because this same tree renders a commit's files and an agent turn's files, neither of
 * which has an index to check anything against.
 */
export function ChangedFilesTree({ files, commentCounts, commit, ...props }: TreeProps & { files: ChangedFile[]; commentCounts: ReadonlyMap<string, number>; commit?: CommitSelection }): React.JSX.Element {
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
  return <Tree root={root} expanded={expanded} toggle={toggle} meta={meta} label="Changed files" commit={commit} {...props} />
}

/**
 * The whole worktree. One flat listing — the same one ⌘O searches — folds into the tree, so
 * opening a folder is instant and costs no git process. Only a worktree too large to list whole
 * falls back to a listing per open folder, fetched on demand. Hovering a file reads it ahead.
 */
export function WorktreeTree({ worktreeId, ...props }: TreeProps & { worktreeId: string }): React.JSX.Element {
  const { expanded, toggle } = useExpanded(() => [], `canopy-worktree-tree:${worktreeId}`)
  const all = useWorktreeFiles(worktreeId, true)
  const whole = all.data !== undefined && !all.data.truncated ? all.data.paths : undefined
  const dirs = useMemo(() => (whole === undefined && all.data !== undefined ? ['', ...expanded] : []), [whole, all.data, expanded])
  const listings = useTrees(worktreeId, dirs)
  const root = useMemo(
    () => (whole !== undefined ? treeFromPaths(whole) : listings.reduce((tree, query) => (query.data ? withListing(tree, query.data.path, query.data.entries) : tree), emptyDir())),
    // Listings settle independently; re-fold when any of them changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [whole, listings.map((q) => q.data)]
  )
  const onHover = useHoverPrefetch(usePrefetchFileContents(worktreeId))
  return <Tree root={root} expanded={expanded} toggle={toggle} label="Worktree files" onHover={onHover} {...props} />
}
