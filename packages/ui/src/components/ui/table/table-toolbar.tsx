import * as React from "react"
import { cva } from "class-variance-authority"
import { ChevronDown, Columns3, ListFilter, Search } from "lucide-react"

import { cn } from "@/lib/utils"
import { Badge } from "../badge"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../dropdown-menu"
import { Input } from "../input"

/**
 * The shared recipe for the toolbar's buttons: one height, one radius, one
 * hover and focus treatment across the filter disclosure, the facet selects,
 * and the column menu, so a toolbar row reads as a set. Exported like
 * `buttonVariants` so a host can build a matching control.
 *
 * `TableSearchField` is deliberately not on this recipe — it is an `Input`,
 * and keeps that component's own field focus treatment; only its height is
 * matched here.
 */
const tableControlVariants = cva(
  "inline-flex h-8 box-border shrink-0 cursor-pointer appearance-none items-center gap-2 whitespace-nowrap rounded-md border border-input bg-transparent font-sans nessa-text-2 font-medium text-foreground outline-none transition-[color,background-color,border-color] [transition-duration:var(--nessa-motion-duration-fast)] [transition-timing-function:var(--nessa-motion-easing-standard)] hover:bg-accent hover:text-accent-foreground focus-visible:[outline-style:solid] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 aria-expanded:border-ring motion-reduce:transition-none",
  {
    variants: {
      padding: {
        default: "px-3",
        tight: "min-w-0 px-2.5",
      },
      state: {
        none: "",
        active:
          "data-[active=true]:border-ring data-[active=true]:bg-accent data-[active=true]:text-accent-foreground",
      },
    },
    defaultVariants: { padding: "default", state: "none" },
  },
)

/**
 * The primary filter row above a table shell: a search field, filter
 * controls, and — pushed right with `ml-auto` — an optional summary. Wraps
 * on narrow hosts.
 */
function TableToolbar({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="table-toolbar"
      className={cn(
        "flex w-full min-w-0 flex-wrap items-center gap-2 font-sans",
        className,
      )}
      {...props}
    />
  )
}

/**
 * The disclosed advanced-filter row a `TableFilterToggle` opens: a bordered
 * card strip holding the secondary filter controls. The host renders it
 * conditionally beneath the toolbar, and should give it an `id` matching the
 * toggle's `aria-controls`.
 */
function TableFilterPanel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="table-filter-panel"
      className={cn(
        "flex w-full min-w-0 flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3 font-sans",
        className,
      )}
      {...props}
    />
  )
}

export interface TableSearchFieldProps extends React.ComponentProps<"input"> {
  /**
   * Extends the inner input element; `className` extends the field wrapper,
   * e.g. to change its flex basis.
   */
  inputClassName?: string
}

/**
 * The toolbar's free-text search: a compact `Input` with a leading search
 * glyph. Give it an accessible name via `aria-label` or an external label.
 */
function TableSearchField({
  className,
  inputClassName,
  type = "search",
  ...props
}: TableSearchFieldProps) {
  return (
    <div
      data-slot="table-search-field"
      className={cn("relative min-w-55 flex-[1_1_17.5rem]", className)}
    >
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        type={type}
        className={cn("h-8 pl-8 nessa-text-input-2", inputClassName)}
        {...props}
      />
    </div>
  )
}

export interface TableFilterToggleProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onSelect"> {
  /** Whether the advanced-filter panel is disclosed; drives `aria-expanded`. */
  open?: boolean
  /**
   * Advanced filters currently active — search excluded. Non-zero renders
   * the count beside the label and tints the control active.
   */
  activeCount?: number
  /** Replaces the default "Filters" label. */
  children?: React.ReactNode
}

/**
 * The disclosure button for a `TableFilterPanel`: a "Filters" control that
 * carries the active-filter count and flips its chevron while open. State
 * stays with the host; wire `onClick` to toggle `open`, and pass
 * `aria-controls` naming the panel it discloses. A panel rendered only
 * while open leaves that reference dangling when collapsed — keep the panel
 * mounted and hidden if your audit requires the id to always resolve.
 */
function TableFilterToggle({
  open = false,
  activeCount = 0,
  className,
  children,
  ...props
}: TableFilterToggleProps) {
  return (
    <button
      type="button"
      data-slot="table-filter-toggle"
      data-active={activeCount > 0}
      aria-expanded={open}
      className={cn(tableControlVariants({ state: "active" }), className)}
      {...props}
    >
      <ListFilter aria-hidden="true" className="size-3.5 shrink-0" />
      {children ?? "Filters"}
      {activeCount > 0 ? (
        <Badge variant="secondary" className="px-1.5 font-mono nessa-text-1 tabular-nums">
          {activeCount}
        </Badge>
      ) : null}
      <ChevronDown
        aria-hidden="true"
        className={cn(
          "size-3.5 shrink-0 transition-transform [transition-duration:var(--nessa-motion-duration-fast)] [transition-timing-function:var(--nessa-motion-easing-standard)] motion-reduce:transition-none",
          open && "rotate-180",
        )}
      />
    </button>
  )
}

export interface TableFilterOption {
  /** Value reported through `onValueChange` when this option is chosen. */
  value: string
  /** Option text in the menu, and the trigger's label while selected. */
  label: React.ReactNode
  /** Faceted result count shown right-aligned beside the option. */
  count?: number
}

export interface TableFilterSelectProps
  extends Omit<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    "value" | "defaultValue" | "onChange" | "onSelect" | "children"
  > {
  /** The facet's name: the menu heading and the trigger's spoken prefix. */
  label: string
  /** The selectable options, in menu order. */
  options: readonly TableFilterOption[]
  /** Selected option value; supply with `onValueChange` to control it. */
  value?: string
  /** Initial selection while uncontrolled. */
  defaultValue?: string
  /** Receives the chosen option's value. */
  onValueChange?: (value: string) => void
  /** Extends the floating menu surface. */
  contentClassName?: string
  /** Portal container for the floating menu; defaults to the body. */
  portalContainer?: HTMLElement | null
}

/**
 * One faceted filter: a compact trigger showing the selected option that
 * opens a single-select menu with optional per-option counts. Controlled via
 * `value`/`onValueChange`, or uncontrolled from `defaultValue`.
 *
 * When the held value names no current option — before an async `options`
 * set arrives, say — the trigger shows the facet name alone rather than
 * standing in a different option: displaying a selection the host was never
 * told about would leave the two disagreeing about what is filtered.
 */
function TableFilterSelect({
  label,
  options,
  value: valueProp,
  defaultValue,
  onValueChange,
  contentClassName,
  portalContainer,
  className,
  ...props
}: TableFilterSelectProps) {
  const [uncontrolledValue, setUncontrolledValue] = React.useState<string>(
    defaultValue ?? "",
  )
  const value = valueProp ?? uncontrolledValue
  const current = options.find((option) => option.value === value)

  const setValue = React.useCallback(
    (nextValue: string) => {
      if (valueProp === undefined) setUncontrolledValue(nextValue)
      onValueChange?.(nextValue)
    },
    [onValueChange, valueProp],
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-slot="table-filter-select"
          className={cn(tableControlVariants({ padding: "tight" }), className)}
          {...props}
        >
          {/* The visible text is the selected option, so the facet name is
              voiced as a prefix rather than replacing it — an aria-label
              alone would leave the visible words unspeakable. */}
          {current ? <span className="sr-only">{label} </span> : null}
          <span className="truncate">{current?.label ?? label}</span>
          <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        data-slot="table-filter-select-content"
        align="start"
        portalContainer={portalContainer}
        className={cn("min-w-44", contentClassName)}
      >
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={setValue}>
          {options.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              className="nessa-text-2"
            >
              <span className="flex-1 truncate">{option.label}</span>
              {option.count !== undefined ? (
                <span className="font-mono nessa-text-1 tabular-nums text-muted-foreground">
                  {option.count}
                </span>
              ) : null}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export interface TableViewColumn {
  /** Stable column key the host uses to track visibility. */
  id: string
  /** Entry text in the menu; usually the column's header label. */
  label: React.ReactNode
  /**
   * Locks the column visible: its entry renders disabled. Keep the id in
   * `value` as well, or the entry renders unchecked and unreachable.
   */
  locked?: boolean
}

export interface TableViewOptionsProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onSelect"> {
  /** Every toggleable column, in menu order. */
  columns: readonly TableViewColumn[]
  /** Ids of the currently visible columns. */
  value: readonly string[]
  /** Receives the next visible-id list. */
  onValueChange?: (value: string[]) => void
  /** Extends the floating menu surface. */
  contentClassName?: string
  /** Portal container for the floating menu; defaults to the body. */
  portalContainer?: HTMLElement | null
  /** Replaces the default "Columns" label. */
  children?: React.ReactNode
  /**
   * Forwarded to the trigger button — a focus destination for a host that
   * hides a column from somewhere that unmounts on the same interaction.
   */
  ref?: React.Ref<HTMLButtonElement>
}

/**
 * The toolbar's column-visibility menu: a "Columns" trigger over one
 * checkbox entry per column. Fully controlled — `value` lists the visible
 * column ids and `onValueChange` receives the next list. The caller's
 * existing order is kept and a restored column is slotted back among its
 * `columns` neighbours, so ids that `columns` does not describe — a fixed
 * selection or actions column — never shift position.
 */
function TableViewOptions({
  columns,
  value,
  onValueChange,
  contentClassName,
  portalContainer,
  className,
  children,
  ref,
  ...props
}: TableViewOptionsProps) {
  const toggle = (id: string, next: boolean) => {
    if (!next) {
      onValueChange?.(value.filter((entry) => entry !== id))
      return
    }
    if (value.includes(id)) return
    // Slot the restored column back among its known neighbours instead of
    // appending it, and leave every other entry — including ids `columns`
    // does not describe, such as a fixed selection column — where it was.
    const order = columns.map((column) => column.id)
    const position = order.indexOf(id)
    const nextValue = [...value]
    const insertAt = nextValue.findIndex((entry) => {
      const entryPosition = order.indexOf(entry)
      return entryPosition !== -1 && entryPosition > position
    })
    nextValue.splice(insertAt === -1 ? nextValue.length : insertAt, 0, id)
    onValueChange?.(nextValue)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          ref={ref}
          type="button"
          data-slot="table-view-options"
          className={cn(tableControlVariants(), className)}
          {...props}
        >
          <Columns3 aria-hidden="true" className="size-3.5 shrink-0" />
          {children ?? "Columns"}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        data-slot="table-view-options-content"
        align="end"
        portalContainer={portalContainer}
        className={cn("min-w-44", contentClassName)}
      >
        <DropdownMenuLabel>Toggle columns</DropdownMenuLabel>
        {columns.map((column) => (
          <DropdownMenuCheckboxItem
            key={column.id}
            checked={value.includes(column.id)}
            disabled={column.locked}
            onCheckedChange={(next) => toggle(column.id, next === true)}
            onSelect={(event) => event.preventDefault()}
            className="nessa-text-2"
          >
            {column.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export {
  TableFilterPanel,
  TableFilterSelect,
  TableFilterToggle,
  TableSearchField,
  TableToolbar,
  TableViewOptions,
  tableControlVariants,
}
