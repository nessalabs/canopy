"use client"

/** @responsibility Renders one fixed, pixel-sized, resizable dock slot around the workspace. */

import * as React from "react"

import { cn } from "@/lib/utils"
import {
  AppShellDockSide,
  resizeDock,
  type AppShellLayout,
} from "@/lib/app-shell-layout"

import { useAppShellContext } from "./app-shell"

const DEFAULT_DOCK_MIN_SIZE = 120
const DEFAULT_DOCK_MAX_SIZE = 640
const DOCK_KEYBOARD_RESIZE_STEP = 16

/** State snapshotted for the lifetime of one dock resize gesture. */
interface DockDragState {
  pointerId: number
  startX: number
  startY: number
  startSize: number
  /** The most recent size the gesture produced, settled on release. */
  latestSize: number
  rightToLeft: boolean
  changed: boolean
}

/** Properties accepted by one AppShell dock. */
interface AppShellDockProps extends React.ComponentProps<"aside"> {
  /** The dock slot this element occupies. */
  side: AppShellDockSide
  /**
   * Smallest pixel extent while resizing.
   * @defaultValue 120
   */
  minSize?: number
  /**
   * Largest pixel extent while resizing.
   * @defaultValue 640
   */
  maxSize?: number
  /**
   * Whether the dock presents its resize separator.
   * @defaultValue true
   */
  resizable?: boolean
  /**
   * Accessible name of the dock's resize separator. Override it to localize
   * or reword what screen readers announce.
   * @defaultValue "Resize left dock" (matching the side)
   */
  resizeHandleLabel?: string
}

/**
 * Resolves the default accessible name for one dock side.
 *
 * @param side - The dock slot.
 * @returns A capitalized, human-readable dock name.
 */
function dockLabel(side: AppShellDockSide): string {
  return `${side.charAt(0).toUpperCase()}${side.slice(1)} dock`
}

/**
 * Works out the dock's new pixel size while its handle is being dragged.
 * Each dock grows when the pointer moves away from its home edge:
 *
 * ```txt
 *   ┌──────┬───────────────┬──────┐
 *   │ left ▸│    center    │◂ right│     ▸ drag right = left grows
 *   │      │               │      │      ◂ drag left  = right grows
 *   ├──────┴───────▴───────┴──────┤      ▴ drag up    = bottom grows
 *   │            bottom           │
 *   └─────────────────────────────┘
 * ```
 *
 * In right-to-left writing mode the left/right directions flip with it.
 *
 * @param side - The dock slot being resized.
 * @param dragState - The gesture's starting snapshot.
 * @param event - The current pointer event.
 * @returns The proposed pixel size before clamping.
 */
function dockSizeForPointer(
  side: AppShellDockSide,
  dragState: DockDragState,
  event: React.PointerEvent<HTMLElement>,
): number {
  if (side === AppShellDockSide.Bottom) {
    return dragState.startSize - (event.clientY - dragState.startY)
  }

  const along =
    (event.clientX - dragState.startX) * (dragState.rightToLeft ? -1 : 1)

  return side === AppShellDockSide.Left
    ? dragState.startSize + along
    : dragState.startSize - along
}

/**
 * Renders one dock slot: a fixed, pixel-sized region beside or below the
 * workspace with an accessible resize separator on its inner edge. Dock
 * pixel sizes are intentionally outside the workspace's weighted tree so a
 * dock keeps its extent when the window resizes.
 *
 * Dock visibility and size live in the shell's layout document; a closed
 * dock renders nothing while retaining its size for reopening.
 *
 * @param props - The dock side, resize bounds, and native properties.
 * @returns The dock element, or null while the dock is closed.
 */
function AppShellDock({
  side,
  minSize = DEFAULT_DOCK_MIN_SIZE,
  maxSize = DEFAULT_DOCK_MAX_SIZE,
  resizable = true,
  resizeHandleLabel,
  className,
  style,
  children,
  id: idProp,
  "aria-label": ariaLabel,
  ...props
}: AppShellDockProps) {
  const { layout, updateLayout } = useAppShellContext()
  const dragStateRef = React.useRef<DockDragState | null>(null)
  const [resizing, setResizing] = React.useState(false)
  const generatedId = React.useId()
  const dockId = idProp ?? generatedId

  const dock = layout.docks[side]
  const bottom = side === AppShellDockSide.Bottom
  const size = Math.min(maxSize, Math.max(minSize, dock.size))

  /**
   * Applies one dock resize through the shared layout document.
   *
   * @param nextSize - The proposed pixel size.
   * @param phase - Whether the gesture is ongoing or settled.
   */
  const applyResize = (nextSize: number, phase: "live" | "settled") => {
    updateLayout(
      (current: AppShellLayout) =>
        resizeDock(current, { side, size: nextSize, minSize, maxSize }),
      { operation: "dock-resize", phase },
    )
  }

  /**
   * Ends a resize gesture. Runs for pointer up, cancel, and lost capture;
   * whichever arrives first wins. The gesture's own last size is settled —
   * not whatever happens to be rendered — so consumers persisting settled
   * events always get the final value, even when the ending event carries
   * no usable coordinates or a re-render is still catching up.
   *
   * @param event - The pointer event ending the gesture.
   */
  const finishResize = (event: React.PointerEvent<HTMLElement>) => {
    const dragState = dragStateRef.current

    if (!dragState || dragState.pointerId !== event.pointerId) return

    dragStateRef.current = null
    setResizing(false)

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    if (dragState.changed) {
      applyResize(dragState.latestSize, "settled")
    }
  }

  if (!dock.open) {
    return null
  }

  return (
    // Consumer props spread first so the attributes the dock owns
    // (id, slot, side, sizing style) always win.
    <aside
      {...props}
      id={dockId}
      data-slot="app-shell-dock"
      data-side={side}
      aria-label={ariaLabel ?? dockLabel(side)}
      className={cn(
        "relative flex shrink-0 flex-col overflow-hidden bg-sidebar text-sidebar-foreground",
        side === AppShellDockSide.Left && "border-e border-border",
        side === AppShellDockSide.Right && "border-s border-border",
        bottom && "w-full border-t border-border",
        className,
      )}
      style={{
        ...style,
        ...(bottom ? { height: size } : { width: size }),
      }}
    >
      {children}
      {resizable ? (
        <div
          role="separator"
          tabIndex={0}
          aria-label={
            resizeHandleLabel ?? `Resize ${dockLabel(side).toLowerCase()}`
          }
          aria-controls={dockId}
          aria-orientation={bottom ? "horizontal" : "vertical"}
          aria-valuenow={size}
          aria-valuemin={minSize}
          aria-valuemax={maxSize}
          data-slot="app-shell-dock-separator"
          data-side={side}
          data-resizing={resizing || undefined}
          className={cn(
            // The dock clips its overflow, so the grab target sits fully
            // inside the inner edge; the border remains the visible line.
            "absolute z-10 bg-transparent outline-none transition-colors select-none touch-none",
            "hover:bg-ring/60 data-resizing:bg-ring",
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0",
            bottom
              ? "inset-x-0 top-0 h-1.5 cursor-row-resize"
              : "inset-y-0 w-1.5 cursor-col-resize",
            side === AppShellDockSide.Left && "end-0",
            side === AppShellDockSide.Right && "start-0",
          )}
          onPointerDown={(event) => {
            if (event.button !== 0 || dragStateRef.current) return

            try {
              event.currentTarget.setPointerCapture(event.pointerId)
            } catch {
              // Synthetic pointer events (tests) have no capturable pointer
              // id; resizing still works through the element's own events.
            }
            dragStateRef.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              startSize: size,
              latestSize: size,
              rightToLeft:
                getComputedStyle(event.currentTarget).direction === "rtl",
              changed: false,
            }
            setResizing(true)
          }}
          onPointerMove={(event) => {
            const dragState = dragStateRef.current

            if (!dragState || dragState.pointerId !== event.pointerId) return

            const nextSize = Math.min(
              maxSize,
              Math.max(minSize, dockSizeForPointer(side, dragState, event)),
            )

            dragState.changed = true
            dragState.latestSize = nextSize
            applyResize(nextSize, "live")
          }}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
          onLostPointerCapture={finishResize}
          onKeyDown={(event) => {
            const rightToLeft =
              getComputedStyle(event.currentTarget).direction === "rtl"

            let nextSize: number | undefined

            switch (event.key) {
              case "ArrowLeft":
                if (!bottom) {
                  const grow = (side === AppShellDockSide.Right) !== rightToLeft
                  nextSize =
                    size + (grow ? 1 : -1) * DOCK_KEYBOARD_RESIZE_STEP
                }
                break
              case "ArrowRight":
                if (!bottom) {
                  const grow = (side === AppShellDockSide.Left) !== rightToLeft
                  nextSize =
                    size + (grow ? 1 : -1) * DOCK_KEYBOARD_RESIZE_STEP
                }
                break
              case "ArrowUp":
                if (bottom) nextSize = size + DOCK_KEYBOARD_RESIZE_STEP
                break
              case "ArrowDown":
                if (bottom) nextSize = size - DOCK_KEYBOARD_RESIZE_STEP
                break
              case "Home":
                nextSize = minSize
                break
              case "End":
                nextSize = maxSize
                break
            }

            if (nextSize === undefined) return

            event.preventDefault()
            applyResize(nextSize, "settled")
          }}
        />
      ) : null}
    </aside>
  )
}

export { AppShellDock, type AppShellDockProps }
