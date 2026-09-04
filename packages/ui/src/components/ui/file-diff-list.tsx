import * as React from "react"
import { ChevronDown } from "lucide-react"

import { cn } from "@/lib/utils"

interface FileDiffCardContextValue {
  expanded: boolean
  toggleExpanded: () => void
  collapsedCount: number
  itemCount: number
  registerItemCount: (count: number) => void
  listId: string
}

const FileDiffCardContext =
  React.createContext<FileDiffCardContextValue | null>(null)

function useFileDiffCardContext(consumer: string): FileDiffCardContextValue {
  const context = React.useContext(FileDiffCardContext)
  if (!context) {
    throw new Error(`${consumer} must be rendered inside a FileDiffCard.`)
  }
  return context
}

export interface FileDiffCardProps extends React.ComponentProps<"div"> {
  expanded?: boolean
  defaultExpanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  collapsedCount?: number
  // Total number of files. The list also reports its child count after
  // mount, but only this prop makes the toggle part of server-rendered
  // and first-paint output.
  itemCount?: number
  // The DOM id of the list element, owned by the card so the toggle's
  // aria-controls always names the rendered list, including in server
  // output. Defaults to a generated id.
  listId?: string
}

function FileDiffCard({
  expanded: controlledExpanded,
  defaultExpanded = false,
  onExpandedChange,
  collapsedCount = 3,
  itemCount: itemCountProp,
  listId: listIdProp,
  className,
  children,
  ...props
}: FileDiffCardProps) {
  const [uncontrolledExpanded, setUncontrolledExpanded] =
    React.useState(defaultExpanded)
  const expanded = controlledExpanded ?? uncontrolledExpanded
  const [registeredItemCount, setRegisteredItemCount] = React.useState(0)
  const itemCount = itemCountProp ?? registeredItemCount
  const generatedListId = React.useId()
  const listId = listIdProp ?? generatedListId

  const toggleExpanded = React.useCallback(() => {
    const next = !expanded
    if (controlledExpanded === undefined) setUncontrolledExpanded(next)
    onExpandedChange?.(next)
  }, [controlledExpanded, expanded, onExpandedChange])

  const contextValue = React.useMemo<FileDiffCardContextValue>(
    () => ({
      expanded,
      toggleExpanded,
      collapsedCount,
      itemCount,
      registerItemCount: setRegisteredItemCount,
      listId,
    }),
    [expanded, toggleExpanded, collapsedCount, itemCount, listId],
  )

  return (
    <FileDiffCardContext.Provider value={contextValue}>
      <div
        data-slot="file-diff-card"
        data-expanded={expanded ? "true" : "false"}
        className={cn(
          "grid overflow-hidden rounded-2xl border border-border bg-card font-sans text-card-foreground shadow-sm",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </FileDiffCardContext.Provider>
  )
}

function FileDiffCardHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="file-diff-card-header"
      className={cn(
        "flex items-center gap-3 border-b border-border px-4 py-3",
        className,
      )}
      {...props}
    />
  )
}

function FileDiffCardIcon({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="file-diff-card-icon"
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground [&_svg]:size-4 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  )
}

function FileDiffCardHeading({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="file-diff-card-heading"
      className={cn("grid min-w-0 flex-1 gap-0.5", className)}
      {...props}
    />
  )
}

function FileDiffCardTitle({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="file-diff-card-title"
      className={cn("truncate nessa-text-4 font-semibold text-foreground", className)}
      {...props}
    />
  )
}

function FileDiffCardActions({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="file-diff-card-actions"
      className={cn("ml-auto flex shrink-0 items-center gap-2", className)}
      {...props}
    />
  )
}

export interface DiffStatProps
  extends Omit<React.ComponentProps<"span">, "children"> {
  additions: number
  deletions: number
}

function DiffStat({ additions, deletions, className, ...props }: DiffStatProps) {
  return (
    <span
      data-slot="diff-stat"
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 nessa-text-2 font-medium tabular-nums",
        className,
      )}
      {...props}
    >
      <span className="sr-only">
        {`${additions} ${additions === 1 ? "addition" : "additions"}, ${deletions} ${deletions === 1 ? "deletion" : "deletions"}`}
      </span>
      <span aria-hidden="true" className="text-[var(--nessa-diff-addition)]">
        +{additions}
      </span>
      <span aria-hidden="true" className="text-[var(--nessa-diff-deletion)]">
        -{deletions}
      </span>
    </span>
  )
}

export interface FileDiffPathProps
  extends Omit<React.ComponentProps<"span">, "children"> {
  path: string
}

function FileDiffPath({ path, className, ...props }: FileDiffPathProps) {
  const separatorIndex = path.lastIndexOf("/")
  const directory = separatorIndex >= 0 ? path.slice(0, separatorIndex + 1) : ""
  const basename = path.slice(separatorIndex + 1)

  return (
    <span
      data-slot="file-diff-path"
      title={path}
      className={cn(
        "min-w-0 truncate nessa-text-4 text-muted-foreground",
        className,
      )}
      {...props}
    >
      {directory ? <span>{directory}</span> : null}
      <span className="font-medium text-foreground">{basename}</span>
    </span>
  )
}

// The list id is owned by FileDiffCard so aria-controls stays coherent.
export type FileDiffListProps = Omit<React.ComponentProps<"ul">, "id">

// Collapsing hides rows, not structural wrappers, so fragments produced by
// grouping (`{groups.map((group) => <Fragment key={group.id}>…</Fragment>)}`)
// are unwrapped before counting and slicing. Each unwrapped row is re-keyed
// under its fragment's key so rows in different fragments cannot collide.
function flattenListChildren(
  children: React.ReactNode,
  keyPrefix = "",
): React.ReactNode[] {
  return React.Children.toArray(children).flatMap((child) => {
    if (
      React.isValidElement<{ children?: React.ReactNode }>(child) &&
      child.type === React.Fragment
    ) {
      return flattenListChildren(
        child.props.children,
        `${keyPrefix}${child.key ?? ""}`,
      )
    }
    return keyPrefix && React.isValidElement(child)
      ? [React.cloneElement(child, { key: `${keyPrefix}${child.key}` })]
      : [child]
  })
}

function FileDiffList({ className, children, ...props }: FileDiffListProps) {
  const { expanded, collapsedCount, registerItemCount, listId } =
    useFileDiffCardContext("FileDiffList")
  const listRef = React.useRef<HTMLUListElement>(null)
  // Scroll regions must be keyboard-reachable, but a tab stop is only owed
  // while the list actually overflows its height cap.
  const [scrollable, setScrollable] = React.useState(false)
  const items = flattenListChildren(children)

  React.useEffect(() => {
    registerItemCount(items.length)
    return () => registerItemCount(0)
  }, [items.length, registerItemCount])

  const updateScrollable = React.useCallback(() => {
    const element = listRef.current
    if (!element) return
    // The 1px tolerance keeps fractional content heights from minting a
    // phantom tab stop on a list that cannot actually scroll.
    setScrollable(element.scrollHeight - element.clientHeight > 1)
  }, [])

  // Content can change height without changing the item count (a path
  // wrapping to two lines, async row content), so overflow is re-measured
  // after every commit; the observer covers non-React resizes.
  React.useEffect(() => {
    updateScrollable()
  })

  React.useEffect(() => {
    const element = listRef.current
    if (!element || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(updateScrollable)
    observer.observe(element)
    return () => observer.disconnect()
  }, [updateScrollable])

  return (
    <ul
      ref={listRef}
      id={listId}
      data-slot="file-diff-list"
      tabIndex={scrollable ? 0 : undefined}
      className={cn(
        // The default height cap keeps hundred-file change sets scrollable
        // inside a stable card instead of growing without bound; hosts
        // override it with their own max-h-* utility.
        "m-0 grid max-h-80 list-none overflow-y-auto p-0 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
        className,
      )}
      {...props}
    >
      {expanded ? items : items.slice(0, collapsedCount)}
    </ul>
  )
}

function FileDiffListItem({
  className,
  ...props
}: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="file-diff-list-item"
      className={cn(
        "group/file-row grid min-h-10 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-4 py-1.5 transition-colors hover:bg-accent/50",
        className,
      )}
      {...props}
    />
  )
}

function FileDiffListItemActions({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="file-diff-list-item-actions"
      className={cn(
        // Reveal binds to :focus-visible, not :focus-within: a pointer click
        // parks focus on the clicked action, and plain focus-within would keep
        // this row's actions lit while the pointer hovers other rows.
        "flex items-center gap-0.5 opacity-0 transition-opacity group-has-[:focus-visible]/file-row:opacity-100 group-hover/file-row:opacity-100",
        className,
      )}
      {...props}
    />
  )
}

function FileDiffListItemAction({
  className,
  type = "button",
  ...props
}: React.ComponentProps<"button">) {
  return (
    <button
      type={type}
      data-slot="file-diff-list-item-action"
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&_svg]:size-3.5 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  )
}

export interface FileDiffListToggleProps
  extends Omit<React.ComponentProps<"button">, "children"> {
  collapseLabel?: string
  showMoreLabel?: (hiddenCount: number) => string
}

function defaultShowMoreLabel(hiddenCount: number) {
  return `Show ${hiddenCount} more ${hiddenCount === 1 ? "file" : "files"}`
}

function FileDiffListToggle({
  collapseLabel = "Collapse files",
  showMoreLabel = defaultShowMoreLabel,
  className,
  type = "button",
  ...props
}: FileDiffListToggleProps) {
  const { expanded, toggleExpanded, collapsedCount, itemCount, listId } =
    useFileDiffCardContext("FileDiffListToggle")
  const hiddenCount = Math.max(0, itemCount - collapsedCount)

  if (hiddenCount === 0) return null

  return (
    <button
      type={type}
      data-slot="file-diff-list-toggle"
      aria-expanded={expanded}
      aria-controls={listId}
      onClick={toggleExpanded}
      className={cn(
        "m-1 flex min-h-9 items-center gap-1.5 rounded-lg border-0 bg-transparent px-3 text-left nessa-text-4 text-muted-foreground outline-none transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className,
      )}
      {...props}
    >
      {expanded ? collapseLabel : showMoreLabel(hiddenCount)}
      <ChevronDown
        aria-hidden="true"
        className={cn("size-3.5 transition-transform", expanded && "rotate-180")}
      />
    </button>
  )
}

export {
  DiffStat,
  FileDiffCard,
  FileDiffCardActions,
  FileDiffCardHeader,
  FileDiffCardHeading,
  FileDiffCardIcon,
  FileDiffCardTitle,
  FileDiffList,
  FileDiffListItem,
  FileDiffListItemAction,
  FileDiffListItemActions,
  FileDiffListToggle,
  FileDiffPath,
}
