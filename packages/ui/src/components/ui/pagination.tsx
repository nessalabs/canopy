"use client"

import * as React from "react"
import { ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react"

import { cn } from "@/lib/utils"

/** The pagination landmark: a nav wrapping a `PaginationContent` list. */
function Pagination({
  className,
  "aria-label": ariaLabel = "Pagination",
  ...props
}: React.ComponentProps<"nav">) {
  return (
    <nav
      data-slot="pagination"
      aria-label={ariaLabel}
      className={cn("mx-auto flex w-full justify-center font-sans", className)}
      {...props}
    />
  )
}

/**
 * The horizontal list of pagination items. Keeps an explicit `list` role:
 * removing the marker style drops list semantics in WebKit, which would
 * cost VoiceOver users the item count.
 */
function PaginationContent({
  className,
  ...props
}: React.ComponentProps<"ul">) {
  return (
    <ul
      role="list"
      data-slot="pagination-content"
      className={cn("flex list-none flex-row items-center gap-0.5 p-0", className)}
      {...props}
    />
  )
}

/** One slot in the pagination list; wraps a link, ellipsis, or control. */
function PaginationItem({ ...props }: React.ComponentProps<"li">) {
  return <li data-slot="pagination-item" {...props} />
}

export interface PaginationLinkProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "disabled"> {
  /**
   * Marks the current page: sets `aria-current="page"` and renders the
   * ring-bordered accent treatment.
   */
  isActive?: boolean
  /**
   * Marks the control unavailable — the range edges, for prev and next.
   * Applied as `aria-disabled` with the activation suppressed rather than
   * the native attribute, so a control that becomes unavailable while
   * focused keeps that focus instead of dropping it to the document body.
   * It leaves the tab order for subsequent passes, which keeps it out of
   * the way without stranding the user mid-interaction.
   */
  disabled?: boolean
}

/**
 * One page control, rendered as a compact button so hosts drive page state
 * from `onClick`. The active page is marked by `aria-current="page"`, a ring
 * border, and heavier type — never by a fill, so the hover wash keeps its
 * single meaning of "under the pointer or keyboard".
 */
function PaginationLink({
  className,
  isActive = false,
  disabled = false,
  onClick,
  tabIndex,
  ...props
}: PaginationLinkProps) {
  return (
    <button
      type="button"
      data-slot="pagination-link"
      data-active={isActive}
      aria-current={isActive ? "page" : undefined}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : tabIndex}
      onClick={(event) => {
        if (disabled) {
          event.preventDefault()
          return
        }
        onClick?.(event)
      }}
      className={cn(
        "inline-flex size-7 box-border shrink-0 cursor-pointer appearance-none items-center justify-center gap-1 whitespace-nowrap rounded-md border border-transparent bg-transparent p-0 font-sans nessa-text-2 tabular-nums text-muted-foreground outline-none transition-[color,background-color,border-color] [transition-duration:var(--nessa-motion-duration-fast)] [transition-timing-function:var(--nessa-motion-easing-standard)] hover:bg-accent hover:text-accent-foreground focus-visible:[outline-style:solid] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:border-ring data-[active=true]:font-semibold data-[active=true]:text-foreground motion-reduce:transition-none [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  )
}

/** The previous-page control: a chevron with an sm-and-up "Previous" label. */
function PaginationPrevious({
  className,
  "aria-label": ariaLabel = "Go to previous page",
  ...props
}: PaginationLinkProps) {
  return (
    <PaginationLink
      aria-label={ariaLabel}
      className={cn("w-auto px-2", className)}
      {...props}
    >
      <ChevronLeft aria-hidden="true" />
      <span className="hidden sm:block">Previous</span>
    </PaginationLink>
  )
}

/** The next-page control: a chevron with an sm-and-up "Next" label. */
function PaginationNext({
  className,
  "aria-label": ariaLabel = "Go to next page",
  ...props
}: PaginationLinkProps) {
  return (
    <PaginationLink
      aria-label={ariaLabel}
      className={cn("w-auto px-2", className)}
      {...props}
    >
      <span className="hidden sm:block">Next</span>
      <ChevronRight aria-hidden="true" />
    </PaginationLink>
  )
}

/** Marks a collapsed run of pages; hidden from assistive tech except a hint. */
function PaginationEllipsis({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="pagination-ellipsis"
      className={cn(
        "inline-flex size-7 items-center justify-center text-muted-foreground",
        className,
      )}
      {...props}
    >
      <MoreHorizontal aria-hidden="true" className="size-3.5" />
      <span className="sr-only">More pages</span>
    </span>
  )
}

export {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
}
