"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "../pagination"

/**
 * Computes the page items a pagination bar shows for `page` of `pageCount`:
 * every page when seven or fewer fit, otherwise a seven-slot window keeping
 * the first page, the last page, and the current page's neighbors, with
 * `"ellipsis"` marking each collapsed run. `page` is clamped into range.
 */
function tablePaginationRange(
  page: number,
  pageCount: number,
): (number | "ellipsis")[] {
  if (pageCount <= 7) {
    return Array.from({ length: Math.max(pageCount, 0) }, (_, index) => index + 1)
  }
  const current = Math.min(Math.max(page, 1), pageCount)
  if (current <= 4) return [1, 2, 3, 4, 5, "ellipsis", pageCount]
  if (current >= pageCount - 3) {
    return [
      1,
      "ellipsis",
      pageCount - 4,
      pageCount - 3,
      pageCount - 2,
      pageCount - 1,
      pageCount,
    ]
  }
  return [1, "ellipsis", current - 1, current, current + 1, "ellipsis", pageCount]
}

// The table pager is a dense strip inside the shell, so its edge controls
// collapse to the chevron alone. They keep `PaginationPrevious`/`Next`'s
// accessible names, so the control is still announced in full.
const paginationEdgeClassName = "w-7 px-0 [&>span]:hidden"

export interface TablePaginationProps
  extends Omit<React.ComponentProps<"div">, "onChange"> {
  /** The current page, 1-based. Clamped into range for every control. */
  page: number
  /** Total pages; `0` renders the pager with no numbered buttons. */
  pageCount: number
  /** Receives the requested page, already clamped into range. */
  onPageChange?: (page: number) => void
  /**
   * Left-aligned result summary, e.g. "Showing 1–12 of 47 traces". Rendered
   * as a status region, so a host feeding it from a live-typing search
   * should debounce the value rather than announcing every keystroke.
   */
  summary?: React.ReactNode
  /** Accessible name of the pagination landmark. */
  paginationLabel?: string
}

/**
 * The pager row under a table's rows, inside the shell: a muted result
 * summary on the left and, composed from the Pagination primitives, compact
 * previous/next controls around a windowed set of numbered page buttons.
 * Fully controlled — the host owns `page` and re-renders on `onPageChange`.
 *
 * `page` is clamped into `[1, pageCount]` for every control, so a page that
 * falls out of range — a filter shrinking the result set before the host
 * resets it — still highlights a real page and cannot step further out. The
 * summary is a status region, so filtering and paging are announced rather
 * than changing silently.
 */
function TablePagination({
  page,
  pageCount,
  onPageChange,
  summary,
  paginationLabel = "Pagination",
  className,
  ...props
}: TablePaginationProps) {
  const safePageCount = Number.isFinite(pageCount)
    ? Math.max(0, Math.floor(pageCount))
    : 0
  const requested = Number.isFinite(page) ? Math.floor(page) : 1
  const currentPage =
    safePageCount === 0 ? 1 : Math.min(Math.max(requested, 1), safePageCount)
  const items = tablePaginationRange(currentPage, safePageCount)

  return (
    <div
      data-slot="table-pagination"
      className={cn(
        "flex box-border min-h-9.5 w-full items-center justify-between gap-2 border-t border-border px-2.5 py-1.5 font-sans",
        className,
      )}
      {...props}
    >
      <div
        role="status"
        className="min-w-0 truncate nessa-text-1 text-muted-foreground"
      >
        {summary}
      </div>
      <Pagination aria-label={paginationLabel} className="mx-0 w-auto shrink-0">
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              className={paginationEdgeClassName}
              disabled={currentPage <= 1}
              onClick={() => onPageChange?.(currentPage - 1)}
            />
          </PaginationItem>
          {items.map((item, index) => (
            <PaginationItem key={item === "ellipsis" ? `ellipsis-${index}` : item}>
              {item === "ellipsis" ? (
                <PaginationEllipsis />
              ) : (
                <PaginationLink
                  aria-label={`Page ${item}`}
                  isActive={item === currentPage}
                  onClick={() => onPageChange?.(item)}
                >
                  {item}
                </PaginationLink>
              )}
            </PaginationItem>
          ))}
          <PaginationItem>
            <PaginationNext
              className={paginationEdgeClassName}
              disabled={currentPage >= safePageCount}
              onClick={() => onPageChange?.(currentPage + 1)}
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  )
}

export { TablePagination, tablePaginationRange }
