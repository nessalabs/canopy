"use client"

import * as React from "react"
import { ChevronRight, LoaderCircle } from "lucide-react"

import { cn } from "@/lib/utils"
import { useVirtualRows } from "@/lib/use-virtual-rows"

/**
 * One visible row of a tree. The host flattens its own hierarchy into the rows
 * that are currently expanded — the component never walks a nested structure,
 * which is what lets it window a tree of any size.
 */
export interface TreeViewNode {
  /** Stable, unique within the tree. */
  id: string
  /** Nesting level; roots are `0`. Only rows whose ancestors are all expanded should be passed. */
  depth: number
  kind: "dir" | "file"
  label: React.ReactNode
  /** Whether a directory is open. Ignored for files. */
  expanded?: boolean
  /** Whether a directory's children are still being fetched. */
  loading?: boolean
  /** Trailing content such as a status badge or diff stat. */
  meta?: React.ReactNode
}

/** Selection and focus state handed to a custom row renderer. */
export interface TreeViewRenderState {
  selected: boolean
  active: boolean
}

export interface TreeViewProps extends Omit<React.ComponentProps<"div">, "onSelect" | "onToggle"> {
  /** The currently visible rows, in display order. */
  nodes: readonly TreeViewNode[]
  /** Id of the selected row, if any. */
  selectedId?: string
  /** A file row was chosen (click, Enter or Space). */
  onSelect?: (node: TreeViewNode) => void
  /** A directory row asked to open or close (click, Enter, ←/→). */
  onToggle?: (node: TreeViewNode) => void
  /** Replaces the default row content. Indentation and the chevron are still owned by the tree. */
  renderRow?: (node: TreeViewNode, state: TreeViewRenderState) => React.ReactNode
  /**
   * Fixed pixel height of every row. Uniform rows are what make windowing exact.
   *
   * @default 28
   */
  rowHeight?: number
  /**
   * Rows mounted beyond the viewport on each side.
   *
   * @default 8
   */
  overscan?: number
  /** Accessible name of the tree. */
  label: string
  emptyMessage?: React.ReactNode
}

/**
 * Index of the nearest row above `index` with a smaller depth, i.e. the parent
 * in the flattened list; `-1` for a root.
 */
export function parentIndexOf(nodes: readonly TreeViewNode[], index: number): number {
  const depth = nodes[index]?.depth ?? 0
  for (let i = index - 1; i >= 0; i--) {
    if ((nodes[i]?.depth ?? 0) < depth) return i
  }
  return -1
}

interface KeyContext {
  nodes: readonly TreeViewNode[]
  index: number
  node: TreeViewNode
  move: (index: number) => void
  toggle: (node: TreeViewNode) => void
  select: (node: TreeViewNode) => void
}

/** Activates a row the way a click does: directories open/close, files select. */
function activate({ node, toggle, select }: KeyContext) {
  if (node.kind === "dir") toggle(node)
  else select(node)
}

/** Every handled key maps to one action; unlisted keys fall through to the browser. */
const KEY_HANDLERS: Record<string, (context: KeyContext) => void> = {
  ArrowDown: ({ index, nodes, move }) => move(Math.min(nodes.length - 1, index + 1)),
  ArrowUp: ({ index, move }) => move(Math.max(0, index - 1)),
  Home: ({ move }) => move(0),
  End: ({ nodes, move }) => move(nodes.length - 1),
  ArrowRight: (context) => {
    const { node, index, nodes, toggle, move } = context
    if (node.kind !== "dir") return
    if (!node.expanded) toggle(node)
    else if (index + 1 < nodes.length) move(index + 1)
  },
  ArrowLeft: (context) => {
    const { node, index, nodes, toggle, move } = context
    if (node.kind === "dir" && node.expanded) toggle(node)
    else {
      const parent = parentIndexOf(nodes, index)
      if (parent >= 0) move(parent)
    }
  },
  Enter: activate,
  " ": activate,
}

/**
 * Indentation is one CSS variable so custom rows and the default row agree,
 * and so a host can retheme the step without touching the component.
 */
const INDENT_STEP = "1rem"

/**
 * A windowed, keyboard-navigable tree for file browsers and outlines.
 *
 * Rows come pre-flattened from the host (`nodes`), so expanding a directory is
 * the host swapping in a longer list — children may arrive lazily and show a
 * spinner meanwhile. Only the rows under the viewport (plus `overscan`) are in
 * the DOM, so a tree with a hundred thousand rows costs the same as one with
 * fifty. Arrow keys move a roving focus (→/← open, close or step to the
 * parent), Enter and Space activate, Home/End jump. Selection is host-owned.
 */
function TreeView({
  nodes,
  selectedId,
  onSelect,
  onToggle,
  renderRow,
  rowHeight = 28,
  overscan = 8,
  label,
  emptyMessage = "Nothing to show",
  className,
  ...props
}: TreeViewProps) {
  const [activeId, setActiveId] = React.useState<string>()
  const rowRefs = React.useRef(new Map<string, HTMLDivElement>())
  const pendingFocus = React.useRef<string | undefined>(undefined)
  const virtual = useVirtualRows({ count: nodes.length, rowHeight, overscan })

  const activeIndex = Math.max(
    0,
    nodes.findIndex((node) => node.id === (activeId ?? selectedId)),
  )

  // Focus lands after the target row is mounted, which may take a scroll + render.
  React.useEffect(() => {
    const id = pendingFocus.current
    if (!id) return
    const element = rowRefs.current.get(id)
    if (element) {
      element.focus()
      pendingFocus.current = undefined
    }
  })

  const move = React.useCallback(
    (index: number) => {
      const node = nodes[index]
      if (!node) return
      setActiveId(node.id)
      pendingFocus.current = node.id
      virtual.scrollToIndex(index)
    },
    [nodes, virtual],
  )

  const contextFor = (index: number): KeyContext | undefined => {
    const node = nodes[index]
    if (!node) return undefined
    return {
      nodes,
      index,
      node,
      move,
      toggle: (target) => onToggle?.(target),
      select: (target) => onSelect?.(target),
    }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, index: number) => {
    const handler = KEY_HANDLERS[event.key]
    const context = contextFor(index)
    if (!handler || !context || event.altKey || event.ctrlKey || event.metaKey) return
    event.preventDefault()
    handler(context)
  }

  const onClick = (index: number) => {
    const context = contextFor(index)
    if (!context) return
    setActiveId(context.node.id)
    activate(context)
  }

  const rows: React.ReactNode[] = []
  for (let index = virtual.range.start; index < virtual.range.end; index++) {
    const node = nodes[index]
    if (!node) continue
    const state = { selected: node.id === selectedId, active: index === activeIndex }
    rows.push(
      <div
        key={node.id}
        ref={(element) => {
          if (element) rowRefs.current.set(node.id, element)
          else rowRefs.current.delete(node.id)
        }}
        role="treeitem"
        data-slot="tree-view-row"
        data-kind={node.kind}
        data-selected={state.selected || undefined}
        aria-level={node.depth + 1}
        aria-selected={state.selected}
        aria-expanded={node.kind === "dir" ? Boolean(node.expanded) : undefined}
        aria-busy={node.loading || undefined}
        tabIndex={state.active ? 0 : -1}
        style={
          {
            top: virtual.offsetFor(index),
            height: rowHeight,
            "--nessa-tree-depth": node.depth,
          } as React.CSSProperties
        }
        className={cn(
          "absolute inset-x-0 flex cursor-default select-none items-center gap-1 pr-2 nessa-text-4 text-foreground outline-none",
          "pl-[calc(var(--nessa-tree-depth)*var(--nessa-tree-indent)+0.5rem)]",
          "hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset",
          "data-[selected]:bg-accent data-[selected]:text-accent-foreground",
        )}
        onClick={() => onClick(index)}
        onKeyDown={(event) => onKeyDown(event, index)}
      >
        <TreeViewChevron node={node} />
        {renderRow ? (
          renderRow(node, state)
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate">{node.label}</span>
            {node.meta ? <span className="shrink-0 text-muted-foreground">{node.meta}</span> : null}
          </>
        )}
      </div>,
    )
  }

  // Roving tabindex lives on the active row. While that row is scrolled out of the window
  // (and so out of the DOM) the tree itself takes the tab stop and hands focus back to the row.
  const activeMounted = activeIndex >= virtual.range.start && activeIndex < virtual.range.end

  return (
    <div
      ref={virtual.scrollRef}
      onScroll={virtual.onScroll}
      role="tree"
      aria-label={label}
      tabIndex={activeMounted || nodes.length === 0 ? -1 : 0}
      onFocus={(event) => {
        if (event.target === event.currentTarget) move(activeIndex)
      }}
      data-slot="tree-view"
      style={{ "--nessa-tree-indent": INDENT_STEP } as React.CSSProperties}
      className={cn("relative min-h-0 overflow-auto", className)}
      {...props}
    >
      {nodes.length === 0 ? (
        <div data-slot="tree-view-empty" className="p-3 nessa-text-4 text-muted-foreground">
          {emptyMessage}
        </div>
      ) : (
        <div style={{ height: virtual.totalHeight }} className="relative w-full">
          {rows}
        </div>
      )}
    </div>
  )
}

/** The leading affordance: a chevron that turns when open, a spinner while loading, a spacer for files. */
function TreeViewChevron({ node }: { node: TreeViewNode }) {
  if (node.kind === "file") return <span aria-hidden="true" className="size-4 shrink-0" />
  if (node.loading) {
    return <LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin text-muted-foreground" />
  }
  return (
    <ChevronRight
      aria-hidden="true"
      className={cn(
        "size-4 shrink-0 text-muted-foreground transition-transform",
        node.expanded && "rotate-90",
      )}
    />
  )
}

export { TreeView }
