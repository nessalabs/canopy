"use client"

import * as React from "react"
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * The scroll chrome a Nessa scroll region wears: a thin, track-less bar with
 * a rounded hairline thumb that strengthens on hover, rather than the
 * platform default. Applied to the table's scroll port; exported so a host
 * building its own scrolling surface can match it.
 */
const tableScrollbarClassName =
  "[scrollbar-width:thin] [scrollbar-color:var(--color-border)_transparent] [&::-webkit-scrollbar]:size-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-corner]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-thumb]:bg-clip-padding [&::-webkit-scrollbar-thumb]:border-2 [&::-webkit-scrollbar-thumb]:border-transparent [&::-webkit-scrollbar-thumb:hover]:bg-muted-foreground"

/**
 * The flat bordered panel a data table sits on: hairline border, card
 * surface, clipped corners, no elevation. Stack a `Table` and, optionally,
 * a `TablePagination` inside it; toolbars belong outside, above the shell.
 */
function TableShell({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="table-shell"
      className={cn(
        "flex box-border w-full min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card font-sans text-card-foreground",
        className,
      )}
      {...props}
    />
  )
}

export interface TableProps extends React.ComponentProps<"table"> {
  /**
   * Extends the scroll container that wraps the table — the node to cap
   * with `max-h-*` for a scrolling body, since the table itself is not the
   * scroll port. Pair a sticky `TableHeader` with `scroll-pt-9` here, or
   * focusing a row control just above the fold scrolls it under the pinned
   * header. Leave the container's top padding at zero: a sticky inset
   * resolves against the padding box.
   */
  containerClassName?: string
  /**
   * Names the scroll container for assistive tech. Applied only while the
   * table overflows and the container is therefore focusable; without it the
   * region is still roled but stays unnamed, which keeps a page of tables
   * from becoming a set of identically-named landmarks. Supply it whenever
   * the table can overflow.
   */
  containerLabel?: string
}

/**
 * The table element inside a scroll container. Establishes the table's
 * compact type scale; renders standalone as a plain table, or inside a
 * `TableShell` for the full panel chrome.
 *
 * Cells default to `whitespace-nowrap`, so wide tables scroll rather than
 * wrap. While the table actually overflows — on either axis, including a
 * height capped through `containerClassName` — the container becomes
 * keyboard focusable so the off-screen rows and columns stay reachable
 * without a pointer, and draws an inset focus outline the shell's clipped
 * corners cannot swallow.
 */
function Table({
  className,
  containerClassName,
  containerLabel,
  ...props
}: TableProps) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = React.useState(false)

  // Only an overflowing region needs a tab stop; adding one to every table
  // would put a focus stop on nothing.
  React.useEffect(() => {
    const element = containerRef.current
    if (!element) return
    // Both axes: a host that caps the height with `containerClassName`
    // scrolls vertically even when every column fits, and that region needs
    // the same keyboard reachability.
    const measure = () =>
      setOverflows(
        element.scrollWidth > element.clientWidth + 1 ||
          element.scrollHeight > element.clientHeight + 1,
      )
    // Measure once regardless, so the initial layout is still handled where
    // ResizeObserver is unavailable.
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    const table = element.firstElementChild
    if (table) observer.observe(table)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      data-slot="table-scroll-frame"
      // The flex column with min-h-0 on frame and container gives the scroll
      // container a real height path: when an ancestor (a TableShell inside a
      // height-capped host, say) constrains the frame, the container shrinks
      // with it and scrolls, instead of percentage caps resolving against an
      // auto-height frame and silently clipping. Auto-height usages lay out
      // exactly as before.
      className="relative flex min-h-0 w-full min-w-0 flex-col"
    >
      <div
        ref={containerRef}
        data-slot="table-container"
        // `region` — not `group` — is the role axe accepts on a focusable
        // scroll container. The name is only applied when the host supplies
        // one: an unnamed region is not a landmark, which keeps every table
        // on a page from becoming an identically-named landmark.
        role={overflows ? "region" : undefined}
        aria-label={overflows ? containerLabel : undefined}
        // Stays programmatically focusable when the overflow goes away, so a
        // container that is focused when the table shrinks keeps its focus
        // instead of dropping it to the document body. The cost is that a
        // pointer click on cell text focuses the container rather than the
        // body; `:focus-visible` does not match that, so nothing is drawn.
        tabIndex={overflows ? 0 : -1}
        className={cn(
          // `overflow-y` is deliberately left unset: CSS coerces it to `auto`
          // beside `overflow-x-auto`, which is what lets a host cap the
          // height through `containerClassName` and get a scrolling body.
          // Setting it explicitly to `visible` or `hidden` would clip rows.
          "peer min-h-0 w-full min-w-0 overflow-x-auto outline-none focus-visible:[outline-style:solid] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
          tableScrollbarClassName,
          containerClassName,
        )}
      >
        <table
          data-slot="table"
          className={cn("w-full caption-bottom font-sans nessa-text-2", className)}
          {...props}
        />
      </div>
      {/* A sticky header cell is an opaque positioned descendant, so it
          paints over the container's own outline and erases the ring's top
          and side segments. This overlay is a later sibling at a higher
          layer, so it draws the same ring above the pinned cells; the two
          share a box and coincide as one. */}
      <div
        aria-hidden="true"
        data-slot="table-focus-ring"
        className="pointer-events-none absolute inset-0 z-20 hidden outline-2 [outline-style:solid] -outline-offset-2 outline-ring peer-focus-visible:block"
      />
    </div>
  )
}

export interface TableHeaderProps extends React.ComponentProps<"thead"> {
  /**
   * Pins the header cells to the top of the scroll container while the body
   * scrolls beneath them — for a table whose height is capped through
   * `Table`'s `containerClassName`.
   *
   * The cells take the card surface so rows cannot show through, and draw
   * their own bottom rule as a shadow: tables collapse their borders, so a
   * sticky cell's border belongs to the collapsed grid and scrolls away with
   * the rows. (MUI instead switches the table to `border-collapse: separate`;
   * that is not open to us, because the separated model ignores borders on
   * `tr` and every row rule in this kit lives there.)
   *
   * The vertical scrollbar belongs to the scroll port, so it runs alongside
   * the pinned header too. That is the same behaviour as MUI's `stickyHeader`
   * and every shadcn sticky-table recipe: the alternative — a separate header
   * table above a scrolling body — severs the programmatic link between each
   * `columnheader` and its cells, and buys a permanent column-width
   * synchronisation problem. The seam is cosmetic and, on platforms with
   * overlay scrollbars, usually invisible.
   *
   * Assumes a single header row — every cell pins at the same offset, so a
   * two-tier grouped header would stack both rows on top of each other — and
   * a scroll container with no top padding, since a sticky inset resolves
   * against the padding box and rows would scroll through the gap above.
   *
   * The surface only applies to cells that set none of their own, so a
   * `TableHead` with a `bg-*` class keeps it. To restyle every cell, pass the
   * same descendant form here: `className="[&_th]:bg-popover"` — a bare
   * `bg-*` would land on the `thead` and the opaque cells would cover it.
   */
  sticky?: boolean
}

/**
 * The column-header row group of a `Table`, optionally pinned to the top of
 * a capped-height scroll container.
 */
function TableHeader({ className, sticky = false, ...props }: TableHeaderProps) {
  return (
    <thead
      data-slot="table-header"
      // Styling and test hook for hosts that need to target the pinned state.
      data-sticky={sticky || undefined}
      className={cn(
        sticky &&
          "[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th:not([class*='bg-'])]:bg-card [&_th]:shadow-[inset_0_-1px_0_var(--color-border)]",
        className,
      )}
      {...props}
    />
  )
}

/**
 * The data row group of a `Table`. Drops the final row's rule so the shell
 * border closes the panel.
 */
function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

/** A summary row group rendered on the muted wash beneath the data rows. */
function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t border-border bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className,
      )}
      {...props}
    />
  )
}

/**
 * One table row: a hairline rule above its successor, a muted hover wash,
 * and a stronger wash while `data-state="selected"`.
 */
function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b border-border transition-colors [transition-duration:var(--nessa-motion-duration-fast)] [transition-timing-function:var(--nessa-motion-easing-standard)] hover:bg-muted/50 data-[state=selected]:bg-muted motion-reduce:transition-none",
        className,
      )}
      {...props}
    />
  )
}

/**
 * A column-header cell: small semibold muted type in sentence case. When the
 * column is sorted, set `aria-sort` here and render a `TableSortButton` as
 * the cell content.
 */
function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-9 whitespace-nowrap px-3 text-left align-middle nessa-text-1 font-semibold text-muted-foreground",
        className,
      )}
      {...props}
    />
  )
}

/** One data cell. Numeric or temporal cells add `font-mono` themselves. */
function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn("whitespace-nowrap px-3 py-2.5 align-middle", className)}
      {...props}
    />
  )
}

/** The table's caption, rendered under the rows in muted type. */
function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("my-3 px-3 nessa-text-2 text-muted-foreground", className)}
      {...props}
    />
  )
}

export interface TableEmptyProps extends React.ComponentProps<"td"> {
  /**
   * Columns the empty state spans. Must equal the number of headers the
   * table currently renders — with toggleable columns, derive it from the
   * visible set rather than hardcoding, or table navigation reports a
   * column count that does not match the header row.
   */
  colSpan: number
}

/**
 * The row a table shows instead of data: a full-width, vertically centered
 * region for an icon, title, and hint. Renders as a single row spanning
 * `colSpan` columns.
 *
 * Deliberately not a live region: it mounts with its content already in
 * place, which several screen readers skip, and it would double up with the
 * host's result summary. Keep one status region — that summary, whether it
 * is `TablePagination`'s or the host's own — for "what the filter did".
 */
function TableEmpty({ colSpan, className, children, ...props }: TableEmptyProps) {
  return (
    <tr data-slot="table-empty">
      <td
        colSpan={colSpan}
        className={cn("h-45 px-6 text-center align-middle", className)}
        {...props}
      >
        <div className="inline-flex flex-col items-center gap-1 whitespace-normal text-muted-foreground">
          {children}
        </div>
      </td>
    </tr>
  )
}

/** A column's sort direction, matching the `aria-sort` token set. */
export type TableSortDirection = "ascending" | "descending"

export interface TableSortButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * The column's current sort direction; omit while unsorted. Mirror the
   * value onto the surrounding `TableHead`'s `aria-sort`.
   */
  direction?: TableSortDirection
}

/**
 * The clickable label of a sortable column header. Shows the sort direction
 * beside the label, or a neutral both-ways glyph while the column is
 * unsorted, and toggles on click — the host owns the cycle, so it can flip
 * between the two directions or add an unsorted step of its own.
 *
 * Column visibility belongs in the toolbar's `TableViewOptions`, not here:
 * a per-header menu for two mutually exclusive directions is more chrome
 * than a toggle needs.
 */
function TableSortButton({
  direction,
  className,
  children,
  ...props
}: TableSortButtonProps) {
  const DirectionIcon =
    direction === "ascending"
      ? ArrowUp
      : direction === "descending"
        ? ArrowDown
        : ChevronsUpDown
  return (
    <button
      type="button"
      data-slot="table-sort-button"
      data-direction={direction}
      className={cn(
        "-mx-1.5 inline-flex cursor-pointer appearance-none items-center gap-1 rounded-md border-0 bg-transparent px-1.5 py-1 font-sans nessa-text-1 font-semibold text-muted-foreground outline-none transition-colors [transition-duration:var(--nessa-motion-duration-fast)] [transition-timing-function:var(--nessa-motion-easing-standard)] hover:bg-accent hover:text-accent-foreground focus-visible:[outline-style:solid] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none",
        className,
      )}
      {...props}
    >
      {children}
      {/* The unsorted glyph is the only cue that a plain-looking header is
          sortable, so it stays at full strength for the 3:1 non-text
          contrast floor. */}
      <DirectionIcon aria-hidden="true" className="size-3 shrink-0" />
    </button>
  )
}

export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableEmpty,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  TableShell,
  TableSortButton,
  tableScrollbarClassName,
}
