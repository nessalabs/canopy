import * as React from "react"

/** A half-open `[start, end)` range of row indices to mount. */
export interface VirtualRange {
  start: number
  end: number
}

/** Tunables shared by the pure math and the hook. */
export interface VirtualRowsOptions {
  /** Total rows in the list. */
  count: number
  /** Height of every row in pixels; rows are assumed uniform. */
  rowHeight: number
  /** Extra rows to mount above and below the viewport so fast scrolling has no blank flashes. */
  overscan?: number
}

/**
 * Rows that intersect a viewport, padded by `overscan` on both sides and
 * clamped to `[0, count)`.
 *
 * @param scrollTop - Scroll offset of the viewport in pixels.
 * @param viewportHeight - Visible height of the viewport in pixels.
 * @param options - Row count, row height and overscan.
 * @returns The half-open index range to mount; `start === end` when nothing fits.
 */
export function visibleRange(
  scrollTop: number,
  viewportHeight: number,
  { count, rowHeight, overscan = 8 }: VirtualRowsOptions,
): VirtualRange {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0 }
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight)
  const visible = Math.ceil(Math.max(0, viewportHeight) / rowHeight)
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(count, first + visible + overscan),
  }
}

/**
 * Scroll offset that brings `index` into a viewport, moving as little as
 * possible: unchanged when the row is already fully visible.
 *
 * @returns The new `scrollTop`.
 */
export function scrollTopForIndex(
  index: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
): number {
  const top = index * rowHeight
  const bottom = top + rowHeight
  if (top < scrollTop) return top
  if (bottom > scrollTop + viewportHeight) return bottom - viewportHeight
  return scrollTop
}

export interface VirtualRows {
  /** Attach to the scrolling element. */
  scrollRef: React.RefObject<HTMLDivElement | null>
  /** Attach as the scrolling element's `onScroll`. */
  onScroll: React.UIEventHandler<HTMLDivElement>
  /** Height of the full list; give it to a relatively-positioned spacer inside the scroller. */
  totalHeight: number
  /** Rows to mount right now. */
  range: VirtualRange
  /** Absolute `top` of a row inside the spacer. */
  offsetFor: (index: number) => number
  /** Scrolls the minimum distance that makes `index` fully visible. */
  scrollToIndex: (index: number) => void
}

/**
 * Windows a fixed-row-height list. The hook owns scroll position and viewport
 * height (via `ResizeObserver`), and returns the index range to mount; the
 * caller renders those rows absolutely positioned with `offsetFor`.
 */
export function useVirtualRows(options: VirtualRowsOptions): VirtualRows {
  const { count, rowHeight } = options
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = React.useState(0)
  const [viewportHeight, setViewportHeight] = React.useState(0)

  React.useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    setViewportHeight(element.clientHeight)
    const observer = new ResizeObserver(() =>
      setViewportHeight(element.clientHeight),
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const onScroll = React.useCallback<React.UIEventHandler<HTMLDivElement>>(
    (event) => setScrollTop(event.currentTarget.scrollTop),
    [],
  )

  const scrollToIndex = React.useCallback(
    (index: number) => {
      const element = scrollRef.current
      if (!element) return
      element.scrollTop = scrollTopForIndex(
        index,
        element.scrollTop,
        element.clientHeight,
        rowHeight,
      )
    },
    [rowHeight],
  )

  const range = React.useMemo(
    () => visibleRange(scrollTop, viewportHeight, options),
    // `options` is destructured so a fresh object per render does not recompute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scrollTop, viewportHeight, count, rowHeight, options.overscan],
  )

  return {
    scrollRef,
    onScroll,
    totalHeight: count * rowHeight,
    range,
    offsetFor: (index) => index * rowHeight,
    scrollToIndex,
  }
}
