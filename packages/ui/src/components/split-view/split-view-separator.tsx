"use client"

/** @responsibility Renders one accessible, keyboard-operable resize separator between two SplitView panels. */

import * as React from "react"

import { cn } from "@/lib/utils"

import { composeRefs, useSplitView } from "./split-view-context"
import { SplitViewOrientation } from "./split-view-options"

/** Properties accepted by one SplitView separator. */
interface SplitViewSeparatorProps extends React.ComponentProps<"div"> {
  /**
   * Accessible name of the separator.
   * @defaultValue "Resize panels"
   */
  "aria-label"?: string
}

/**
 * Renders the interactive separator between two adjacent SplitView panels.
 *
 * The separator implements the ARIA window-splitter pattern: it is
 * focusable, reports the reachable size range of the panel before it, and
 * resizes with arrow keys, Home, End, and Enter (collapse toggle for
 * collapsible panels). Pointer resizing uses pointer capture on the
 * separator itself.
 *
 * @param props - An optional accessible name and native element properties.
 * @returns A focusable separator element wired to its SplitView group.
 */
function SplitViewSeparator({
  "aria-label": ariaLabel = "Resize panels",
  className,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onLostPointerCapture,
  onKeyDown,
  ref,
  ...props
}: SplitViewSeparatorProps) {
  const {
    activeSeparatorId,
    getSeparatorAria,
    onSeparatorKeyDown,
    onSeparatorPointerDown,
    onSeparatorPointerEnd,
    onSeparatorPointerMove,
    orientation,
    registerSeparator,
  } = useSplitView()
  const separatorId = React.useId()
  const elementRef = React.useRef<HTMLDivElement>(null)
  // Memoized so React does not detach and re-attach refs on every render.
  const composedRef = React.useMemo(() => composeRefs(elementRef, ref), [ref])

  React.useLayoutEffect(() => {
    const element = elementRef.current

    if (!element) {
      return
    }

    return registerSeparator(separatorId, element)
  }, [registerSeparator, separatorId])

  const aria = getSeparatorAria(separatorId)
  const horizontal = orientation === SplitViewOrientation.Horizontal
  const resizing = activeSeparatorId === separatorId

  return (
    // Consumer props spread first so the accessibility attributes the
    // separator owns (role, focus, values) can never be broken from outside.
    <div
      {...props}
      ref={composedRef}
      role="separator"
      // A separator without a valid panel pair (a markup error) stays out of
      // the tab order instead of presenting an inert focusable widget.
      tabIndex={aria ? 0 : -1}
      aria-label={ariaLabel}
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      aria-controls={aria?.controls}
      aria-valuenow={aria?.valueNow}
      aria-valuemin={aria?.valueMin}
      aria-valuemax={aria?.valueMax}
      data-slot="split-view-separator"
      data-orientation={orientation}
      data-resizing={resizing || undefined}
      className={cn(
        "relative z-10 shrink-0 bg-border outline-none transition-colors select-none touch-none",
        "after:absolute hover:bg-ring/60 data-resizing:bg-ring",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0",
        horizontal
          ? "w-px cursor-col-resize after:inset-y-0 after:-start-1 after:-end-1"
          : "h-px cursor-row-resize after:inset-x-0 after:-top-1 after:-bottom-1",
        className,
      )}
      onPointerDown={(event) => {
        onPointerDown?.(event)
        if (!event.defaultPrevented) onSeparatorPointerDown(separatorId, event)
      }}
      onPointerMove={(event) => {
        onPointerMove?.(event)
        if (!event.defaultPrevented) onSeparatorPointerMove(separatorId, event)
      }}
      onPointerUp={(event) => {
        onPointerUp?.(event)
        if (!event.defaultPrevented) onSeparatorPointerEnd(separatorId, event)
      }}
      onPointerCancel={(event) => {
        onPointerCancel?.(event)
        if (!event.defaultPrevented) onSeparatorPointerEnd(separatorId, event)
      }}
      onLostPointerCapture={(event) => {
        onLostPointerCapture?.(event)
        onSeparatorPointerEnd(separatorId, event)
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (!event.defaultPrevented) onSeparatorKeyDown(separatorId, event)
      }}
    />
  )
}

export { SplitViewSeparator, type SplitViewSeparatorProps }
