import * as React from "react"

import { cn } from "@/lib/utils"
import { swapPanes, type LayoutNodeId } from "@/lib/app-shell-layout"

import { useAppShellContext } from "./app-shell"

/**
 * The pane a drag is currently hovering. Dropping anywhere on a pane swaps
 * the two panes; new sections are created with the split actions instead.
 */
interface PaneDropTarget {
  paneId: LayoutNodeId
}

/** Shared state and callbacks for one workspace's drag interactions. */
interface AppShellDragContextValue {
  /** The pane currently being dragged, if any. */
  draggingPaneId: LayoutNodeId | null
  /** The pane and region the drag is hovering, if any. */
  dropTarget: PaneDropTarget | null
  /**
   * Starts a drag for one pane. A faded miniature of the pane follows the
   * cursor as the drag ghost. Returns false — and starts nothing — when
   * another drag is already in progress (for example a second finger).
   */
  startDrag: (paneId: LayoutNodeId) => boolean
  /** Updates the ghost position and drop target from the pointer. */
  moveDrag: (clientX: number, clientY: number) => void
  /** Ends the drag, applying the move or swap when `commit` is true. */
  endDrag: (commit: boolean) => void
}

const AppShellDragContext =
  React.createContext<AppShellDragContextValue | null>(null)

/**
 * Reads the drag state of the nearest workspace. Useful for custom pane
 * chrome that wants to react to an active drag.
 *
 * @returns The current drag context value.
 * @throws When called outside an AppShellWorkspace.
 */
function useAppShellDrag(): AppShellDragContextValue {
  const context = React.useContext(AppShellDragContext)

  if (!context) {
    throw new Error(
      "Pane drag components must be used within an AppShellWorkspace.",
    )
  }

  return context
}

/**
 * Cleanup cancelers for glides still in flight, so re-animating a pane can
 * cancel the previous glide's timers before writing new styles.
 */
const pendingGlideCleanups = new WeakMap<HTMLElement, () => void>()

/**
 * Animates panes gliding from their previous spots to their new ones after
 * a drop (the classic first-last-invert-play technique): remember where a
 * pane was, let the layout move it, then start it back at the old spot and
 * let a transform transition carry it home. Skipped for people who prefer
 * reduced motion.
 *
 * @param workspace - The workspace element holding the panes.
 * @param paneIds - The panes about to move.
 */
function animatePaneMoves(
  workspace: HTMLElement,
  paneIds: readonly LayoutNodeId[],
) {
  if (
    typeof matchMedia !== "undefined" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    return
  }

  const before = new Map<string, DOMRect>()

  for (const pane of workspace.querySelectorAll<HTMLElement>(
    '[data-slot="app-shell-pane"]',
  )) {
    const id = pane.dataset.paneId

    if (id && paneIds.includes(id)) {
      before.set(id, pane.getBoundingClientRect())
    }
  }

  if (before.size === 0) return

  // Two frames so the layout change has definitely been painted into the
  // DOM before the new positions are measured.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      for (const pane of workspace.querySelectorAll<HTMLElement>(
        '[data-slot="app-shell-pane"]',
      )) {
        const previous = pane.dataset.paneId
          ? before.get(pane.dataset.paneId)
          : undefined

        if (!previous) continue

        const next = pane.getBoundingClientRect()

        if (next.width === 0 || next.height === 0) continue

        const deltaX = previous.left - next.left
        const deltaY = previous.top - next.top
        const scaleX = previous.width / next.width
        const scaleY = previous.height / next.height

        if (
          Math.abs(deltaX) < 1 &&
          Math.abs(deltaY) < 1 &&
          Math.abs(scaleX - 1) < 0.01 &&
          Math.abs(scaleY - 1) < 0.01
        ) {
          continue
        }

        // A glide already running on this pane hands over cleanly: its
        // timers are canceled so they cannot snap the new glide mid-flight.
        pendingGlideCleanups.get(pane)?.()

        pane.style.transformOrigin = "top left"
        pane.style.transition = "none"
        pane.style.transform = `translate(${deltaX}px, ${deltaY}px) scale(${scaleX}, ${scaleY})`
        // Swapping panes cross each other mid-flight; lifting them above
        // their neighbors and making them slightly see-through keeps the
        // brief overlap readable instead of jarring.
        pane.style.zIndex = "30"
        pane.style.opacity = "0.9"
        void pane.offsetWidth // settle the starting position without animating

        let timeoutId: ReturnType<typeof setTimeout>

        /** Only the pane's own transform ending counts — color or hover
         * transitions bubbling up from content must not cut the glide. */
        const onTransitionEnd = (event: TransitionEvent) => {
          if (event.target === pane && event.propertyName === "transform") {
            finish()
          }
        }

        const cancel = () => {
          clearTimeout(timeoutId)
          pane.removeEventListener("transitionend", onTransitionEnd)
          pendingGlideCleanups.delete(pane)
        }

        const finish = () => {
          cancel()
          pane.style.transition = ""
          pane.style.transform = ""
          pane.style.transformOrigin = ""
          pane.style.zIndex = ""
          pane.style.opacity = ""
        }

        pane.style.transition = "transform 150ms ease"
        pane.style.transform = ""
        pane.addEventListener("transitionend", onTransitionEnd)
        timeoutId = setTimeout(finish, 250)
        pendingGlideCleanups.set(pane, cancel)
      }
    }),
  )
}

/**
 * Finds the pane under a pointer position. The whole pane is one drop
 * target — releasing anywhere on it swaps the two panes.
 *
 * @param workspace - The workspace element holding the panes.
 * @param draggingPaneId - The pane being dragged (never its own target).
 * @param clientX - The pointer's horizontal position.
 * @param clientY - The pointer's vertical position.
 * @returns The hovered pane, or null between panes.
 */
function findDropTarget(
  workspace: HTMLElement,
  draggingPaneId: LayoutNodeId,
  clientX: number,
  clientY: number,
): PaneDropTarget | null {
  const panes = workspace.querySelectorAll<HTMLElement>(
    '[data-slot="app-shell-pane"]',
  )

  for (const pane of panes) {
    const paneId = pane.dataset.paneId

    if (!paneId || paneId === draggingPaneId) continue

    const rect = pane.getBoundingClientRect()

    if (
      rect.width === 0 ||
      clientX < rect.left ||
      clientX > rect.right ||
      clientY < rect.top ||
      clientY > rect.bottom
    ) {
      continue
    }

    return { paneId }
  }

  return null
}

/**
 * Provides drag coordination for one workspace. Rendered by
 * AppShellWorkspace; applications never mount it directly.
 *
 * @param props - The workspace element ref and the workspace content.
 * @returns A context provider wiring drag state to the layout document.
 */
function AppShellDragProvider({
  workspaceRef,
  children,
}: {
  workspaceRef: React.RefObject<HTMLElement | null>
  children: React.ReactNode
}) {
  const { updateLayout } = useAppShellContext()
  const [draggingPaneId, setDraggingPaneId] =
    React.useState<LayoutNodeId | null>(null)
  const [dropTarget, setDropTarget] = React.useState<PaneDropTarget | null>(
    null,
  )
  const draggingRef = React.useRef<LayoutNodeId | null>(null)
  const dropTargetRef = React.useRef<PaneDropTarget | null>(null)
  const ghostRef = React.useRef<HTMLDivElement | null>(null)
  const lastPointRef = React.useRef<{ x: number; y: number } | null>(null)

  /** Places the ghost at a pointer position and makes it visible. */
  const placeGhost = React.useCallback((element: HTMLDivElement, x: number, y: number) => {
    element.style.transform = `translate(${x + 14}px, ${y + 12}px)`
    element.style.visibility = "visible"
  }, [])

  // The ghost mounts one render after the drag starts. This mounting ref
  // fills it with a scaled-down snapshot of the dragged pane (a plain DOM
  // clone — nothing interactive, hidden from assistive tech) and places it
  // at the last known pointer position; without that it would stay
  // invisible until the next pointer move.
  const attachGhost = React.useCallback(
    (element: HTMLDivElement | null) => {
      ghostRef.current = element

      if (!element) return

      // Pane ids are consumer-supplied strings, so the pane is found by
      // comparing dataset values — never by interpolating the id into a
      // CSS selector, where quotes or backslashes would throw.
      const source = draggingRef.current
        ? [
            ...(workspaceRef.current?.querySelectorAll<HTMLElement>(
              '[data-slot="app-shell-pane"]',
            ) ?? []),
          ].find((pane) => pane.dataset.paneId === draggingRef.current)
        : null

      if (source) {
        const rect = source.getBoundingClientRect()
        const scale = Math.min(280 / rect.width, 220 / rect.height, 0.5)

        element.style.width = `${Math.round(rect.width * scale)}px`
        element.style.height = `${Math.round(rect.height * scale)}px`

        // The pane's content wrapper is cloned (not the pane shell), and
        // the lift-out invisibility is stripped so the ghost shows the
        // content the slot just stopped showing.
        const content =
          source.querySelector<HTMLElement>(
            '[data-slot="app-shell-pane-content"]',
          ) ?? source
        const snapshot = content.cloneNode(true) as HTMLElement
        // The clone must never look like a real pane to the drop hit test.
        snapshot.removeAttribute("data-slot")
        snapshot.removeAttribute("data-pane-id")
        snapshot.classList.remove("invisible")
        snapshot.style.width = `${rect.width}px`
        snapshot.style.height = `${rect.height}px`
        snapshot.style.transform = `scale(${scale})`
        snapshot.style.transformOrigin = "top left"
        snapshot.style.opacity = "1"
        element.replaceChildren(snapshot)
      }

      if (lastPointRef.current) {
        placeGhost(element, lastPointRef.current.x, lastPointRef.current.y)
      }
    },
    [placeGhost, workspaceRef],
  )

  const startDrag = React.useCallback((paneId: LayoutNodeId) => {
    if (draggingRef.current !== null) return false

    draggingRef.current = paneId
    setDraggingPaneId(paneId)
    return true
  }, [])

  const moveDrag = React.useCallback(
    (clientX: number, clientY: number) => {
      const workspace = workspaceRef.current
      const paneId = draggingRef.current

      if (!workspace || !paneId) return

      // The ghost is positioned imperatively — a style write per pointer
      // move — so following the cursor never re-renders anything.
      lastPointRef.current = { x: clientX, y: clientY }

      if (ghostRef.current) {
        placeGhost(ghostRef.current, clientX, clientY)
      }

      const next = findDropTarget(workspace, paneId, clientX, clientY)
      const previous = dropTargetRef.current

      if (next?.paneId === previous?.paneId) {
        return
      }

      dropTargetRef.current = next
      setDropTarget(next)
    },
    [workspaceRef],
  )

  const endDrag = React.useCallback(
    (commit: boolean) => {
      const paneId = draggingRef.current
      const target = dropTargetRef.current

      draggingRef.current = null
      dropTargetRef.current = null
      lastPointRef.current = null
      setDraggingPaneId(null)
      setDropTarget(null)

      if (!commit || !paneId || !target) return

      // Both panes glide to their new spots instead of jumping; their old
      // positions must be captured before the layout changes.
      const workspace = workspaceRef.current

      if (workspace) {
        animatePaneMoves(workspace, [paneId, target.paneId])
      }

      // A drop always swaps the two panes in place — the tree's structure
      // and orientations stay exactly as they are. New sections come from
      // the explicit split actions, not from dragging.
      updateLayout(
        (current) => swapPanes(current, { paneId, withPaneId: target.paneId }),
        { operation: "swap", phase: "settled" },
      )
    },
    [updateLayout, workspaceRef],
  )

  React.useEffect(() => {
    if (draggingPaneId === null) return

    /** Cancels the drag without moving anything. */
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        endDrag(false)
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [draggingPaneId, endDrag])

  const contextValue = React.useMemo<AppShellDragContextValue>(
    () => ({ draggingPaneId, dropTarget, startDrag, moveDrag, endDrag }),
    [draggingPaneId, dropTarget, startDrag, moveDrag, endDrag],
  )

  return (
    <AppShellDragContext.Provider value={contextValue}>
      {children}
      {draggingPaneId !== null ? (
        // The ghost — a faded miniature of the dragged pane — rides the
        // cursor. It mounts hidden; the mounting ref fills and places it.
        <div
          ref={attachGhost}
          aria-hidden
          inert
          data-slot="app-shell-drag-ghost"
          className="pointer-events-none invisible fixed left-0 top-0 z-50 overflow-hidden rounded-md border border-border bg-background opacity-90 shadow-lg"
        />
      ) : null}
    </AppShellDragContext.Provider>
  )
}

/** Properties accepted by the pane drag handle. */
interface AppShellPaneDragHandleProps extends React.ComponentProps<"div"> {
  /** The pane this handle moves. */
  paneId: LayoutNodeId
}

/** Pixels the pointer must travel before a press becomes a drag. */
const DRAG_START_THRESHOLD = 4

/**
 * Makes part of a pane's chrome (usually its header or a grip icon)
 * draggable: press, move past a small threshold, hover another pane (its
 * whole surface highlights), and release to swap the two panes. Escape
 * cancels. Splitting into new sections stays an explicit action — dragging
 * only rearranges.
 *
 * Dragging is a pointer-only affordance; keyboard users reach the same
 * layouts through the split and close actions, so the handle stays out of
 * the tab order.
 *
 * @param props - The pane id and native container properties.
 * @returns A draggable element wired to the workspace's drag state.
 */
function AppShellPaneDragHandle({
  paneId,
  className,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onLostPointerCapture,
  children,
  ...props
}: AppShellPaneDragHandleProps) {
  const { draggingPaneId, startDrag, moveDrag, endDrag } = useAppShellDrag()
  const pressRef = React.useRef<{
    pointerId: number
    startX: number
    startY: number
    started: boolean
  } | null>(null)

  /** Ends any press or drag this handle owns. */
  const finish = (event: React.PointerEvent<HTMLElement>, commit: boolean) => {
    const press = pressRef.current

    if (!press || press.pointerId !== event.pointerId) return

    pressRef.current = null

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    if (press.started) {
      endDrag(commit)
    }
  }

  return (
    // Consumer props spread first so the attributes the handle owns win.
    <div
      {...props}
      data-slot="app-shell-pane-drag-handle"
      data-dragging={draggingPaneId === paneId || undefined}
      className={cn(
        "cursor-grab touch-none select-none data-dragging:cursor-grabbing",
        className,
      )}
      onPointerDown={(event) => {
        onPointerDown?.(event)
        if (event.defaultPrevented || event.button !== 0 || pressRef.current)
          return

        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          // Synthetic pointer events (tests) have no capturable pointer id;
          // dragging still works through the element's own move events.
        }

        pressRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          started: false,
        }
      }}
      onPointerMove={(event) => {
        onPointerMove?.(event)
        const press = pressRef.current

        if (!press || press.pointerId !== event.pointerId) return

        if (!press.started) {
          const traveled = Math.hypot(
            event.clientX - press.startX,
            event.clientY - press.startY,
          )

          if (traveled < DRAG_START_THRESHOLD) return

          if (!startDrag(paneId)) {
            // Another pane is already being dragged; abandon this press so
            // a second pointer can never steer or commit the first drag.
            pressRef.current = null
            return
          }

          press.started = true
        }

        moveDrag(event.clientX, event.clientY)
      }}
      onPointerUp={(event) => {
        onPointerUp?.(event)
        finish(event, true)
      }}
      onPointerCancel={(event) => {
        onPointerCancel?.(event)
        finish(event, false)
      }}
      onLostPointerCapture={(event) => {
        onLostPointerCapture?.(event)
        finish(event, false)
      }}
    >
      {children}
    </div>
  )
}

export {
  AppShellDragProvider,
  AppShellPaneDragHandle,
  useAppShellDrag,
  type AppShellDragContextValue,
  type AppShellPaneDragHandleProps,
  type PaneDropTarget,
}
