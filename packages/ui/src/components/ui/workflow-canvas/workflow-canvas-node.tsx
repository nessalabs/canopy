import * as React from "react"

import { cn } from "@/lib/utils"

import {
  WorkflowCanvasNodeContext,
  composeWorkflowCanvasRefs,
  useWorkflowCanvas,
  useWorkflowCanvasNodeGeometry,
  type WorkflowCanvasNodeContextValue,
} from "./workflow-canvas-context"
import {
  clampPositionToBounds,
  nearestNodeSide,
  type WorkflowCanvasPoint,
  type WorkflowCanvasSide,
} from "./workflow-canvas-math"

/**
 * The interaction that produced a node position change: a drag, an arrow
 * key, or the node growing until the canvas bounds pushed it back inside.
 */
type WorkflowCanvasNodeTrigger = "pointer" | "keyboard" | "resize"

/** State snapshotted for the lifetime of one node drag gesture. */
interface WorkflowCanvasNodeDragState {
  /** The pointer that started the gesture; other pointers are ignored. */
  pointerId: number
  startClientX: number
  startClientY: number
  /** Where the pointer was at the previous step, for incremental deltas. */
  lastClientX: number
  lastClientY: number
  /**
   * The position the pointer alone implies, before bounds are applied.
   * Tracking it separately keeps the grab offset: travelling past a bound
   * and back returns the node to the cursor rather than to the edge.
   */
  freePosition: WorkflowCanvasPoint
  latestPosition: WorkflowCanvasPoint
  /** Whether the pointer travelled far enough to count as a drag. */
  moved: boolean
}

/** Properties accepted by one canvas node. */
interface WorkflowCanvasNodeProps extends React.ComponentProps<"div"> {
  /** The node's unique id within its canvas, referenced by edges. */
  nodeId: string
  /**
   * The node's position in canvas units when it is controlled by its
   * consumer. Interactions report the next position through
   * `onPositionChange`; the consumer renders it back through this property.
   */
  position?: WorkflowCanvasPoint
  /** Initial position for an uncontrolled node. */
  defaultPosition?: WorkflowCanvasPoint
  /** Called with the next position on every step of an interaction. */
  onPositionChange?: (
    position: WorkflowCanvasPoint,
    meta: { trigger: WorkflowCanvasNodeTrigger },
  ) => void
  /** Called once per settled gesture with the final position. */
  onPositionCommit?: (position: WorkflowCanvasPoint) => void
  /** Whether the node presents as selected. */
  selected?: boolean
  /**
   * Whether the node presents collapsed when it is controlled by its
   * consumer: its `WorkflowCanvasNodeBody` children hide and only the rest
   * of its content — typically a header row — remains.
   */
  collapsed?: boolean
  /** Initial collapsed state for an uncontrolled node. */
  defaultCollapsed?: boolean
  /** Called when a toggle moves the node between collapsed and expanded. */
  onCollapsedChange?: (collapsed: boolean) => void
  /**
   * Called when Delete or Backspace is pressed on the focused node — the
   * moment to remove it (and its edges) from consumer state.
   */
  onDelete?: () => void
}

/**
 * Reads whether a pointer-down landed on something that owns its own
 * gesture — a control, editable text, a connection handle, or a canvas
 * nested inside the node — so dragging never steals from it.
 *
 * @param target - The event target.
 * @param node - The node element considering the gesture.
 * @returns Whether the node should leave the gesture alone.
 */
function targetOwnsGesture(target: Element, node: Element): boolean {
  const owner = target.closest(
    'button, a, input, textarea, select, [contenteditable="true"], [data-slot="workflow-canvas-handle"], [data-workflow-canvas-no-drag]',
  )

  // A control marked drag-through — the node's own collapse toggle — works
  // like a window title bar: a clean click activates it, while a movement
  // past the drag threshold moves the node (and the trailing click is
  // suppressed before it can reach the control).
  if (owner !== null && !owner.hasAttribute("data-workflow-canvas-drag-through")) {
    return true
  }

  // A canvas nested inside this node owns its own panning; the canvas this
  // node lives on does not block the drag.
  const nearestCanvas = target.closest('[data-slot="workflow-canvas"]')

  return nearestCanvas !== null && node.contains(nearestCanvas)
}

/**
 * One node on a workflow canvas: an absolutely placed box that renders any
 * content, drags with the pointer, moves with arrow keys while focused, and
 * anchors the edges that reference its `nodeId`.
 *
 * The node is fully controlled when `position` is provided. Compose
 * `WorkflowCanvasNodeHandle` children to offer connection points on its
 * sides; they reveal on hover, on focus, and while a connection is being
 * drawn anywhere on the canvas. Controls, editable fields, nested
 * canvases, and anything marked `data-workflow-canvas-no-drag` own their
 * own gestures and never start a drag; styling the node itself with CSS
 * `resize` keeps its native grip working, presses there resizing the node
 * instead of dragging it.
 *
 * @param props - The node id, controlled or uncontrolled position, change
 * callbacks, selection state, and native container properties.
 * @returns The positioned node element providing node context.
 */
function WorkflowCanvasNode({
  nodeId,
  position: positionProp,
  defaultPosition,
  onPositionChange,
  onPositionCommit,
  selected,
  collapsed: collapsedProp,
  defaultCollapsed = false,
  onCollapsedChange,
  onDelete,
  className,
  style,
  children,
  ref,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onKeyDown,
  onClick,
  onClickCapture,
  ...props
}: WorkflowCanvasNodeProps) {
  const canvas = useWorkflowCanvas("WorkflowCanvasNode")
  const elementRef = React.useRef<HTMLDivElement>(null)
  const composedRef = React.useMemo(
    () => composeWorkflowCanvasRefs(elementRef, ref),
    [ref],
  )
  const storedGeometry = useWorkflowCanvasNodeGeometry(nodeId)
  const dragStateRef = React.useRef<WorkflowCanvasNodeDragState | null>(null)
  const suppressClickRef = React.useRef(false)
  // Detaches the document-level settle for a press that claimed the board.
  const detachClaimRef = React.useRef<(() => void) | null>(null)
  // Pending trailing commit for a run of resize-driven clamps.
  const resizeCommitRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  // Carries an uncontrolled node's live position across a nodeId change,
  // where the old registration is removed and a new one created.
  const carriedPositionRef = React.useRef<WorkflowCanvasPoint | null>(null)
  const [dragging, setDragging] = React.useState(false)
  // The node's own hover and focus-within, tracked here rather than read
  // from a CSS group: a group selector matches ANY ancestor carrying the
  // class, so a host node wrapping a nested canvas would reveal every
  // handle inside that canvas at once.
  const [hovered, setHovered] = React.useState(false)
  const [focusWithin, setFocusWithin] = React.useState(false)
  const [uncontrolledCollapsed, setUncontrolledCollapsed] =
    React.useState(defaultCollapsed)
  const resolvedCollapsed = collapsedProp ?? uncontrolledCollapsed

  const isControlled = positionProp !== undefined

  // In the render where nodeId changes, the new id has no geometry yet;
  // the old id's position (still registered until effects run) carries
  // over so the node never paints a frame at its default position.
  const lastNodeIdRef = React.useRef(nodeId)
  // The id of the most recent render, so a cleanup can tell a rename —
  // where the element survives — from a real unmount.
  const renderedNodeIdRef = React.useRef(nodeId)
  renderedNodeIdRef.current = nodeId
  const renderCarried =
    lastNodeIdRef.current !== nodeId && positionProp === undefined
      ? canvas.geometry.get(lastNodeIdRef.current)
      : undefined

  const resolvedPosition =
    positionProp ??
    (storedGeometry
      ? { x: storedGeometry.x, y: storedGeometry.y }
      : undefined) ??
    (renderCarried
      ? { x: renderCarried.x, y: renderCarried.y }
      : undefined) ??
    defaultPosition ?? { x: 0, y: 0 }

  const resolvedPositionRef = React.useRef(resolvedPosition)
  resolvedPositionRef.current = resolvedPosition

  const callbacksRef = React.useRef({ onPositionChange, onPositionCommit })
  callbacksRef.current = { onPositionChange, onPositionCommit }

  const isControlledRef = React.useRef(isControlled)
  isControlledRef.current = isControlled

  React.useLayoutEffect(() => {
    lastNodeIdRef.current = nodeId

    const element = elementRef.current
    const carried = carriedPositionRef.current
    carriedPositionRef.current = null
    const initial = carried ?? resolvedPositionRef.current

    canvas.geometry.setPosition(nodeId, initial.x, initial.y)

    if (element) {
      canvas.geometry.setSize(nodeId, element.offsetWidth, element.offsetHeight)
    }

    return () => {
      // A node unmounting mid-drag would strand its claim on the board,
      // leaving the canvas refusing every later background press.
      const abandoned = dragStateRef.current

      if (abandoned) {
        dragStateRef.current = null
        detachClaimRef.current?.()
        canvas.releaseNodeDrag(abandoned.pointerId)

        // A rename runs this cleanup while the element stays mounted, so
        // the gesture has to be settled rather than merely dropped: the
        // node would otherwise keep its grabbing cursor and raised layer
        // for good, and the moves already reported through
        // onPositionChange would never be committed.
        if (renderedNodeIdRef.current !== nodeId) {
          setDragging(false)

          if (abandoned.moved) {
            suppressClickRef.current = true
            callbacksRef.current.onPositionCommit?.(abandoned.latestPosition)
          }

          const element = elementRef.current

          if (element?.hasPointerCapture(abandoned.pointerId)) {
            element.releasePointerCapture(abandoned.pointerId)
          }
        }
      }

      // A renamed node keeps its place: the position rides across to the
      // next registration instead of resetting to the default.
      const parting = canvas.geometry.get(nodeId)
      carriedPositionRef.current = parting
        ? { x: parting.x, y: parting.y }
        : null

      canvas.geometry.remove(nodeId)

      // A connection can't finish once its source node is gone; drop it so
      // no line lingers pointing at nothing.
      const pending = canvas.connection.get()

      if (pending && pending.source === nodeId) {
        canvas.connection.set(null)
      }
    }
  }, [canvas.connection, canvas.geometry, nodeId])

  React.useLayoutEffect(() => {
    // A controlled node mirrors its prop into the geometry store so the
    // edges attached to it follow the consumer's state.
    if (positionProp) {
      canvas.geometry.setPosition(nodeId, positionProp.x, positionProp.y)
    }
  }, [canvas.geometry, nodeId, positionProp])

  const applyPosition = React.useCallback(
    (next: WorkflowCanvasPoint, trigger: WorkflowCanvasNodeTrigger) => {
      if (!isControlledRef.current) {
        canvas.geometry.setPosition(nodeId, next.x, next.y)
      }

      callbacksRef.current.onPositionChange?.(next, { trigger })
    },
    [canvas.geometry, nodeId],
  )

  React.useEffect(() => {
    const element = elementRef.current

    if (!element || typeof ResizeObserver === "undefined") {
      return
    }

    const observer = new ResizeObserver(() => {
      canvas.geometry.setSize(nodeId, element.offsetWidth, element.offsetHeight)

      // A node that grew may now overhang the canvas bounds. Re-clamping
      // here keeps it inside; without it the next drag or arrow press
      // would clamp for the first time and jump backwards by the growth.
      const bounds = canvas.getBounds()

      if (bounds) {
        const current = resolvedPositionRef.current
        const clamped = clampPositionToBounds(
          current,
          { width: element.offsetWidth, height: element.offsetHeight },
          bounds,
        )

        if (clamped.x !== current.x || clamped.y !== current.y) {
          applyPosition(clamped, "resize")

          // A ResizeObserver fires every frame a size changes, but a
          // commit is promised once per settled gesture — so the trailing
          // call is rescheduled until the resizing stops.
          if (resizeCommitRef.current !== null) {
            clearTimeout(resizeCommitRef.current)
          }

          resizeCommitRef.current = setTimeout(() => {
            resizeCommitRef.current = null
            callbacksRef.current.onPositionCommit?.(
              resolvedPositionRef.current,
            )
          }, 120)
        }
      }
    })

    observer.observe(element)

    return () => {
      observer.disconnect()

      if (resizeCommitRef.current !== null) {
        clearTimeout(resizeCommitRef.current)
        resizeCommitRef.current = null
      }
    }
  }, [applyPosition, canvas, canvas.boundsKey, canvas.geometry, nodeId])

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    onPointerDown?.(event)

    // A second finger belongs to a pinch, never to a node drag; it falls
    // through untouched. (Real pointers only: synthetic test events have
    // no pointer type and report isPrimary false.)
    if (!event.isPrimary && (event.pointerType as string) !== "") {
      return
    }

    // A node styled with a native CSS resize keeps its grip: a press on
    // the grip corner resizes the node instead of dragging it — and never
    // pans a read-only canvas underneath the resize either.
    if (event.button === 0) {
      const computedStyle = getComputedStyle(event.currentTarget)

      if (computedStyle.resize !== "none") {
        const rect = event.currentTarget.getBoundingClientRect()
        const gripExtent =
          24 * canvas.getViewport().zoom * canvas.getScreenScale()
        // The native grip sits at the inline-end corner: bottom-right in
        // LTR, bottom-left in RTL.
        const onGripX =
          computedStyle.direction === "rtl"
            ? event.clientX <= rect.left + gripExtent
            : event.clientX >= rect.right - gripExtent

        if (onGripX && event.clientY >= rect.bottom - gripExtent) {
          event.stopPropagation()
          return
        }
      }
    }

    // A read-only canvas has no node dragging; the press falls through to
    // the canvas so it pans from anywhere.
    if (canvas.readOnly) {
      return
    }

    // The node isolates its gestures so dragging never bubbles into an
    // ancestor node or pans the canvas underneath.
    event.stopPropagation()

    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      dragStateRef.current ||
      targetOwnsGesture(event.target as Element, event.currentTarget)
    ) {
      return
    }

    // No pointer capture yet: capturing on press would retarget the
    // trailing click to the node, so a clean click on a drag-through
    // control (the collapse toggle) could never activate it. The capture
    // happens the moment the movement becomes a drag.
    dragStateRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      freePosition: resolvedPositionRef.current,
      latestPosition: resolvedPositionRef.current,
      moved: false,
    }

    // Claimed from the press, not from the drag threshold: in between, a
    // second finger on the background would otherwise pan the plane out
    // from under the held node and fire a spurious dismissal.
    canvas.claimNodeDrag(event.pointerId)

    // Without capture the release can land anywhere, so the claim is
    // settled from the document — a press that slips off the node and
    // lifts elsewhere must never strand it, which would leave the canvas
    // refusing every later background press.
    const ownerDocument = event.currentTarget.ownerDocument
    const settleClaim = (settleEvent: PointerEvent) => {
      if (settleEvent.pointerId !== event.pointerId) {
        return
      }

      detachClaimRef.current?.()

      if (
        dragStateRef.current?.pointerId === settleEvent.pointerId &&
        !dragStateRef.current.moved
      ) {
        dragStateRef.current = null
      }

      canvas.releaseNodeDrag(settleEvent.pointerId)
    }

    detachClaimRef.current?.()
    ownerDocument.addEventListener("pointerup", settleClaim, true)
    ownerDocument.addEventListener("pointercancel", settleClaim, true)
    detachClaimRef.current = () => {
      detachClaimRef.current = null
      ownerDocument.removeEventListener("pointerup", settleClaim, true)
      ownerDocument.removeEventListener("pointercancel", settleClaim, true)
    }
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    onPointerMove?.(event)

    const dragState = dragStateRef.current

    if (!dragState || dragState.pointerId !== event.pointerId) {
      return
    }

    // Without capture (deferred until the drag starts), a press that slips
    // off the node before moving 3px never delivers its release here — a
    // mouse keeps its pointer id, so a later button-less hover would match
    // this state and drag with no button held. A move without the primary
    // button is a dead gesture. (Real pointers only: synthetic test events
    // report no buttons at all.)
    if ((event.pointerType as string) !== "" && (event.buttons & 1) === 0) {
      dragStateRef.current = null
      setDragging(false)
      detachClaimRef.current?.()
      canvas.releaseNodeDrag(event.pointerId)

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }

      if (dragState.moved) {
        callbacksRef.current.onPositionCommit?.(dragState.latestPosition)
      }

      return
    }

    // A canvas turning read-only mid-gesture settles the drag where it
    // stands: the moves already applied are real, so they are committed
    // rather than left unreported.
    if (canvas.readOnly) {
      dragStateRef.current = null
      setDragging(false)
      detachClaimRef.current?.()
      canvas.releaseNodeDrag(event.pointerId)

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }

      if (dragState.moved) {
        suppressClickRef.current = true
        callbacksRef.current.onPositionCommit?.(dragState.latestPosition)
      }

      return
    }

    // A tiny wobble under the pointer stays a click, not a drag.
    if (
      !dragState.moved &&
      Math.hypot(
        event.clientX - dragState.startClientX,
        event.clientY - dragState.startClientY,
      ) < 3
    ) {
      return
    }

    if (!dragState.moved) {
      dragState.moved = true
      setDragging(true)

      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // Synthetic pointer events (tests) have no capturable pointer id;
        // dragging still works through the element's own move events.
      }
    }

    // Each step converts only the movement since the previous step, at the
    // scale in force right now — so a wheel zoom landing mid-drag rebases
    // the gesture instead of displacing the node. Client pixels shrink to
    // canvas units through the canvas' own zoom and any ancestor scaling.
    const scale = canvas.getViewport().zoom * canvas.getScreenScale()
    const geometry = canvas.geometry.get(nodeId)
    // The pointer's own travel accumulates unclamped; the bounds are
    // applied only to what is rendered, so an overshoot is remembered and
    // the node returns to the cursor instead of leading it back.
    const free = {
      x:
        dragState.freePosition.x +
        (event.clientX - dragState.lastClientX) / scale,
      y:
        dragState.freePosition.y +
        (event.clientY - dragState.lastClientY) / scale,
    }
    const next = clampPositionToBounds(
      free,
      { width: geometry?.width ?? 0, height: geometry?.height ?? 0 },
      canvas.getBounds(),
    )

    dragState.lastClientX = event.clientX
    dragState.lastClientY = event.clientY
    dragState.freePosition = free
    dragState.latestPosition = next
    applyPosition(next, "pointer")
  }

  const handlePointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current

    if (!dragState || dragState.pointerId !== event.pointerId) {
      return
    }

    dragStateRef.current = null
    setDragging(false)
    detachClaimRef.current?.()
    canvas.releaseNodeDrag(event.pointerId)

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    if (dragState.moved) {
      // Only a released pointer produces a trailing click; a cancelled
      // gesture must not leave the suppression armed for the next click.
      if (event.type !== "pointercancel") {
        suppressClickRef.current = true
      }

      callbacksRef.current.onPositionCommit?.(dragState.latestPosition)
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event)

    // Movement keys act on the node itself, never on a focused control
    // inside it; a read-only canvas has no node movement or deletion.
    if (
      event.defaultPrevented ||
      event.target !== event.currentTarget ||
      canvas.readOnly
    ) {
      return
    }

    if ((event.key === "Delete" || event.key === "Backspace") && onDelete) {
      event.preventDefault()
      event.stopPropagation()

      // The consumer decides whether anything is deleted — it may refuse,
      // or confirm first — so focus is only rescued if the node actually
      // left the document, matching how a dismissal recovers focus.
      const activeBefore = event.currentTarget

      onDelete()
      queueMicrotask(() => {
        if (!activeBefore.isConnected) {
          canvas.getRootElement()?.focus()
        }
      })

      return
    }

    const step = canvas.keyboardMoveStep * (event.shiftKey ? 4 : 1)
    const current = resolvedPositionRef.current
    let next: WorkflowCanvasPoint | undefined

    switch (event.key) {
      case "ArrowLeft":
        next = { x: current.x - step, y: current.y }
        break
      case "ArrowRight":
        next = { x: current.x + step, y: current.y }
        break
      case "ArrowUp":
        next = { x: current.x, y: current.y - step }
        break
      case "ArrowDown":
        next = { x: current.x, y: current.y + step }
        break
    }

    if (!next) {
      return
    }

    event.preventDefault()
    event.stopPropagation()

    const geometry = canvas.geometry.get(nodeId)
    const clamped = clampPositionToBounds(
      next,
      { width: geometry?.width ?? 0, height: geometry?.height ?? 0 },
      canvas.getBounds(),
    )

    applyPosition(clamped, "keyboard")
    callbacksRef.current.onPositionCommit?.(clamped)

    // The move may have walked the node off screen; nudge the viewport so
    // keyboard users can see what they are moving.
    canvas.revealRegion({
      x: clamped.x,
      y: clamped.y,
      width: geometry?.width ?? 0,
      height: geometry?.height ?? 0,
    })
  }

  // The click that ends a drag is part of the drag, not an activation —
  // for the node's own onClick AND for any drag-through control (the
  // collapse toggle) the gesture happened to start on, so suppression
  // runs in the capture phase, before the click can reach either.
  const handleClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    // Only a pointer-trailing click (detail >= 1) can conclude a drag; a
    // keyboard activation arrives with detail 0 and must never be eaten
    // by suppression a click-less touch drag left armed.
    if (suppressClickRef.current && event.detail !== 0) {
      suppressClickRef.current = false
      event.preventDefault()
      event.stopPropagation()
      return
    }

    onClickCapture?.(event)
  }

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    onClick?.(event)
  }

  const onCollapsedChangeRef = React.useRef(onCollapsedChange)
  onCollapsedChangeRef.current = onCollapsedChange

  const setCollapsed = React.useCallback(
    (next: boolean) => {
      if (collapsedProp === undefined) {
        setUncontrolledCollapsed(next)
      }

      onCollapsedChangeRef.current?.(next)
    },
    [collapsedProp],
  )

  const nodeContextValue = React.useMemo<WorkflowCanvasNodeContextValue>(
    () => ({
      nodeId,
      collapsed: resolvedCollapsed,
      setCollapsed,
      revealed: hovered || focusWithin,
    }),
    [nodeId, resolvedCollapsed, setCollapsed, hovered, focusWithin],
  )

  return (
    <WorkflowCanvasNodeContext.Provider value={nodeContextValue}>
      {/* Consumer props spread first so the attributes the node owns
          (slot, position transform, gesture handlers) always win. */}
      <div
        role="group"
        tabIndex={0}
        {...props}
        ref={composedRef}
        data-slot="workflow-canvas-node"
        data-node-id={nodeId}
        data-selected={selected ? "true" : undefined}
        data-collapsed={resolvedCollapsed ? "true" : undefined}
        data-dragging={dragging ? "true" : undefined}
        className={cn(
          "group/workflow-node absolute top-0 left-0 box-border select-none data-[dragging=true]:cursor-grabbing data-[dragging=true]:z-10",
          canvas.readOnly ? "cursor-default" : "cursor-grab",
          // Selection reads as a soft halo around the node rather than a
          // hard ring, which would double up with the border most node
          // content already draws.
          "rounded-2xl data-[selected=true]:shadow-[0_0_0_4px_color-mix(in_oklab,var(--ring)_15%,transparent),0_10px_28px_-12px_color-mix(in_oklab,var(--ring)_55%,transparent)]",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          className,
        )}
        style={{
          ...style,
          // The node's placement composes with — never yields to — a
          // transform the consumer styles on, such as a hover scale.
          transform: `translate(${resolvedPosition.x}px, ${resolvedPosition.y}px)${
            typeof style?.transform === "string" ? ` ${style.transform}` : ""
          }`,
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => {
          onPointerUp?.(event)
          handlePointerEnd(event)
        }}
        onPointerCancel={(event) => {
          onPointerCancel?.(event)
          handlePointerEnd(event)
        }}
        onPointerDownCapture={(event) => {
          props.onPointerDownCapture?.(event)

          if (!event.isPrimary && (event.pointerType as string) !== "") {
            return
          }

          // A touch drag ends without a trailing click, so suppression
          // left armed from a previous gesture retires when any new press
          // begins. The capture phase is the only place that sees them
          // all: a press inside a nested canvas, an inner node, or a
          // handle stops pointerdown before it could bubble to this node.
          suppressClickRef.current = false
        }}
        onKeyDown={handleKeyDown}
        onClickCapture={handleClickCapture}
        onClick={handleClick}
        onPointerEnter={(event) => {
          props.onPointerEnter?.(event)
          setHovered(true)
        }}
        onPointerLeave={(event) => {
          props.onPointerLeave?.(event)
          setHovered(false)
        }}
        onBlur={(event) => {
          props.onBlur?.(event)

          if (
            !event.currentTarget.contains(event.relatedTarget as Node | null)
          ) {
            setFocusWithin(false)
          }
        }}
        onFocus={(event) => {
          props.onFocus?.(event)
          setFocusWithin(true)

          // The canvas clips rather than scrolls, so a node reached by Tab
          // could sit off screen with nothing to reveal it. Panning to it
          // keeps keyboard focus visible. A pointer press focuses the node
          // too, and panning then would tear it out from under the cursor,
          // so only keyboard focus (:focus-visible) reveals — tested on
          // whatever actually received focus, since backward tabbing
          // reaches a node's handles before the node itself.
          const focused = event.target as Element

          if (
            typeof focused.matches === "function" &&
            focused.matches(":focus-visible")
          ) {
            const geometry = canvas.geometry.get(nodeId)

            if (geometry) {
              canvas.revealRegion(geometry)
            }
          }
        }}
      >
        {children}
      </div>
    </WorkflowCanvasNodeContext.Provider>
  )
}

const handleSideClasses: Record<WorkflowCanvasSide, string> = {
  top: "top-0 left-1/2 -translate-x-1/2 -translate-y-1/2",
  right: "top-1/2 right-0 translate-x-1/2 -translate-y-1/2",
  bottom: "bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2",
  left: "top-1/2 left-0 -translate-x-1/2 -translate-y-1/2",
}

/** Properties accepted by one connection handle. */
interface WorkflowCanvasNodeHandleProps extends React.ComponentProps<"button"> {
  /** The node side the handle sits on and connections attach through. */
  side: WorkflowCanvasSide
  /**
   * A custom indicator — an icon, a badge, any element — rendered in place
   * of the default dot. The handle keeps its placement, reveal, and
   * connection behavior around whatever is passed.
   */
  children?: React.ReactNode
}

/**
 * A connection point on one side of a node. Dragging from a handle draws a
 * live connection line; releasing over another node or handle reports the
 * connection through the canvas' `onConnect`. With the keyboard, activating
 * one handle starts the connection and activating a handle on another node
 * completes it; Escape abandons it.
 *
 * Handles stay hidden until the node is hovered or focused, or while any
 * connection is being drawn, so they read as an affordance near the edges
 * without cluttering the graph. Pass children to replace the default dot
 * with a custom indicator.
 *
 * @param props - The side to sit on, an optional custom indicator, and
 * native button properties.
 * @returns The handle button element.
 */
function WorkflowCanvasNodeHandle({
  side,
  className,
  children,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onClick,
  ...props
}: WorkflowCanvasNodeHandleProps) {
  const canvas = useWorkflowCanvas("WorkflowCanvasNodeHandle")
  const node = React.useContext(WorkflowCanvasNodeContext)

  if (node === null) {
    throw new Error(
      "WorkflowCanvasNodeHandle must be used within a WorkflowCanvasNode.",
    )
  }

  const { nodeId } = node
  const draggingRef = React.useRef<number | null>(null)
  // Whether the imminent click concludes a pointer gesture on this handle,
  // as opposed to a keyboard or assistive-technology activation.
  const pointerSessionRef = React.useRef(false)

  // The snapshot collapses to a tiny string so pointer moves elsewhere on
  // the canvas never re-render this handle. It carries both flags the
  // handle presents: whether it armed the pending connection, and whether
  // ANY connection is in flight on THIS canvas — read from the handle's
  // own context rather than a CSS group selector, which would match any
  // ancestor canvas and leak an outer canvas' state into a nested one.
  const connectionFlags = React.useSyncExternalStore(
    canvas.connection.subscribe,
    () => {
      const pending = canvas.connection.get()

      return `${
        pending !== null &&
        pending.source === nodeId &&
        pending.sourceSide === side
          ? 1
          : 0
      }${pending !== null ? 1 : 0}`
    },
    () => "00",
  )
  const isConnectionSource = connectionFlags[0] === "1"
  const isConnecting = connectionFlags[1] === "1"

  // A read-only canvas draws no connections, so the handle leaves the DOM
  // rather than hiding: as a class, `hidden` shares tailwind-merge's
  // display group with the `block`/`flex` below and would be stripped.
  if (canvas.readOnly) {
    return null
  }

  const settlePointerConnection = (clientX: number, clientY: number) => {
    const ownRoot = canvas.getRootElement()
    const dropped = document.elementFromPoint(clientX, clientY)

    // Only elements of THIS canvas can receive the connection: a nested
    // subflow renders its own nodes and handles with the same slots, and
    // a drop on one of them must resolve to its host node instead.
    const belongsToOwnCanvas = (element: Element): boolean =>
      element.closest('[data-slot="workflow-canvas"]') === ownRoot

    const handleTarget = dropped?.closest<HTMLElement>(
      '[data-slot="workflow-canvas-handle"]',
    )

    if (
      handleTarget?.dataset.nodeId &&
      handleTarget.dataset.side &&
      belongsToOwnCanvas(handleTarget)
    ) {
      canvas.completeConnection(
        handleTarget.dataset.nodeId,
        handleTarget.dataset.side as WorkflowCanvasSide,
      )
      return
    }

    let nodeTarget =
      dropped?.closest<HTMLElement>('[data-slot="workflow-canvas-node"]') ??
      null

    // Walk out of foreign (nested) canvases until reaching a node this
    // canvas owns, so a drop on a subflow preview connects to its host.
    while (nodeTarget && !belongsToOwnCanvas(nodeTarget)) {
      nodeTarget =
        nodeTarget.parentElement?.closest<HTMLElement>(
          '[data-slot="workflow-canvas-node"]',
        ) ?? null
    }

    if (nodeTarget?.dataset.nodeId) {
      const geometry = canvas.geometry.get(nodeTarget.dataset.nodeId)
      const point = canvas.clientPointToCanvasPoint(clientX, clientY)

      canvas.completeConnection(
        nodeTarget.dataset.nodeId,
        geometry ? nearestNodeSide(geometry, point) : "left",
      )
      return
    }

    // Released over this canvas' open background: report the drop point so
    // the consumer can offer follow-up UI there (for example a palette of
    // nodes to create). A release outside the canvas is a plain cancel.
    if (dropped && ownRoot?.contains(dropped)) {
      canvas.endConnectionAtPoint(
        canvas.clientPointToCanvasPoint(clientX, clientY),
      )
    } else {
      canvas.cancelConnection()
    }
  }

  return (
    <button
      type="button"
      aria-label={`Connect ${side}`}
      aria-pressed={isConnectionSource}
      {...props}
      data-slot="workflow-canvas-handle"
      data-node-id={nodeId}
      data-side={side}
      data-connecting={isConnecting ? "true" : undefined}
      className={cn(
        "absolute box-border cursor-crosshair appearance-none border-0 bg-transparent p-0",
        // Own-context state, never an ancestor group selector: a nested
        // editable canvas keeps its handles even inside a read-only outer
        // one, and an outer connection never reveals inner handles.
        // Hidden handles are inert too: an opacity-0 button would still
        // hit-test, stealing touch drags and taps at the node's edges.
        "pointer-events-none opacity-0",
        // The reveal follows THIS node's own hover and focus, read from
        // node context: an ancestor group selector would match the host
        // node of a nested canvas and light up every handle inside it.
        node.revealed && "pointer-events-auto opacity-100",
        "data-[connecting=true]:pointer-events-auto data-[connecting=true]:opacity-100 focus-visible:pointer-events-auto",
        "transition-[opacity,scale] [transition-duration:var(--nessa-motion-duration-fast)] [transition-timing-function:var(--nessa-motion-easing-standard)] motion-reduce:transition-none",
        "focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        // The dot stays small and quiet, but the grab and drop area does
        // not: a ::before pad extends the hit box well past the visual, so
        // a connection can be started — and released — without pixel
        // precision on a 10px target that sits half outside the card.
        "before:absolute before:-inset-2 before:content-['']",
        children == null
          ? "block size-2.5 rounded-full border-[1.5px] border-ring/40 bg-card hover:scale-125 hover:border-ring hover:bg-ring/15 aria-pressed:scale-125 aria-pressed:border-ring aria-pressed:bg-ring/20 data-[connecting=true]:border-ring data-[connecting=true]:bg-ring/15"
          : "flex items-center justify-center",
        handleSideClasses[side],
        className,
      )}
      onPointerDown={(event) => {
        onPointerDown?.(event)

        // A second finger belongs to a pinch, never to a connection.
        if (!event.isPrimary && (event.pointerType as string) !== "") {
          return
        }

        // Only a main-button press can end in a trailing click; anything
        // else (right-click, cancelled touch) must not arm the flag it
        // could never clear.
        if (event.button === 0) {
          pointerSessionRef.current = true
        }

        // A read-only canvas draws no connections; the press falls through
        // to the canvas so it pans instead.
        if (canvas.readOnly) {
          return
        }

        event.stopPropagation()

        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          draggingRef.current !== null
        ) {
          return
        }

        // A press while a keyboard-armed connection waits settles it:
        // completing on another node, cancelling back on its source. A
        // connection a pointer is actively dragging belongs to that
        // pointer alone — other presses stay inert until it settles.
        const pending = canvas.connection.get()

        if (pending !== null) {
          if (pending.mode === "keyboard") {
            if (pending.source === nodeId) {
              canvas.cancelConnection()
            } else {
              canvas.completeConnection(nodeId, side)
            }
          }

          return
        }

        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          // Synthetic pointer events (tests) have no capturable pointer id;
          // connecting still works through the element's own move events.
        }

        draggingRef.current = event.pointerId
        canvas.beginConnection(nodeId, side, "pointer")
      }}
      onPointerMove={(event) => {
        onPointerMove?.(event)

        if (draggingRef.current !== event.pointerId) {
          return
        }

        // A canvas turning read-only mid-gesture drops the connection.
        if (canvas.readOnly) {
          draggingRef.current = null
          return
        }

        canvas.moveConnection(event.clientX, event.clientY)
      }}
      onPointerUp={(event) => {
        onPointerUp?.(event)

        if (draggingRef.current !== event.pointerId) {
          return
        }

        draggingRef.current = null
        event.stopPropagation()

        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }

        if (!canvas.readOnly) {
          settlePointerConnection(event.clientX, event.clientY)
        }
      }}
      onPointerCancel={(event) => {
        onPointerCancel?.(event)

        // A cancelled gesture produces no trailing click to clear the
        // session flag, so it retires here.
        pointerSessionRef.current = false

        if (draggingRef.current === event.pointerId) {
          draggingRef.current = null
          canvas.cancelConnection()
        }
      }}
      onClick={(event) => {
        onClick?.(event)

        if (event.defaultPrevented) {
          return
        }

        // Drawing a connection is not activating the node, so the click
        // never reaches the node's own handling — pointer or keyboard.
        event.stopPropagation()

        // A click concluding this handle's own pointer gesture was
        // already handled by that gesture. Anything else — keyboard
        // activations (detail 0, immune to a stale flag left by a
        // click-less touch), or the bare clicks assistive technology
        // sends — is an activation.
        const followsPointerGesture =
          pointerSessionRef.current && event.detail !== 0

        pointerSessionRef.current = false

        if (followsPointerGesture || canvas.readOnly) {
          return
        }

        const pending = canvas.connection.get()

        if (pending === null) {
          canvas.beginConnection(nodeId, side, "keyboard")
        } else if (pending.mode !== "keyboard") {
          // A connection a pointer is actively dragging belongs to that
          // pointer alone; an activation elsewhere stays inert.
          return
        } else if (pending.source === nodeId) {
          canvas.cancelConnection()
        } else {
          canvas.completeConnection(nodeId, side)
        }
      }}
    >
      {children}
    </button>
  )
}

/** Properties accepted by the node collapse toggle. */
interface WorkflowCanvasNodeToggleProps
  extends React.ComponentProps<"button"> {}

/**
 * A button that folds its node between collapsed and expanded. Place it in
 * the part of the node that stays visible — typically a header row — and
 * the node's `WorkflowCanvasNodeBody` children hide while collapsed, so a
 * whole subflow can shrink to a single pill until it is wanted. Renders a
 * turning chevron by default; pass children for a custom indicator.
 *
 * @param props - Native button properties and an optional custom indicator.
 * @returns The toggle button element.
 */
function WorkflowCanvasNodeToggle({
  className,
  children,
  onClick,
  ...props
}: WorkflowCanvasNodeToggleProps) {
  const node = React.useContext(WorkflowCanvasNodeContext)

  if (node === null) {
    throw new Error(
      "WorkflowCanvasNodeToggle must be used within a WorkflowCanvasNode.",
    )
  }

  return (
    <button
      type="button"
      aria-label="Toggle content"
      aria-expanded={!node.collapsed}
      {...props}
      data-slot="workflow-canvas-node-toggle"
      data-workflow-canvas-drag-through=""
      className={cn(
        "box-border inline-flex size-6 shrink-0 cursor-pointer appearance-none items-center justify-center rounded-md border-0 bg-transparent p-0 text-muted-foreground hover:text-foreground",
        "transition-colors [transition-duration:var(--nessa-motion-duration-fast)] [transition-timing-function:var(--nessa-motion-easing-standard)] motion-reduce:transition-none",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className,
      )}
      onClick={(event) => {
        onClick?.(event)

        if (event.defaultPrevented) {
          return
        }

        // Folding a node is not activating it; the node's own click
        // handling stays out of it.
        event.stopPropagation()
        node.setCollapsed(!node.collapsed)
      }}
    >
      {children ?? (
        <svg
          aria-hidden="true"
          viewBox="0 0 10 6"
          className="w-2.5 transition-transform [transition-duration:var(--nessa-motion-duration-fast)] [transition-timing-function:var(--nessa-motion-easing-standard)] motion-reduce:transition-none group-data-[collapsed=true]/workflow-node:-rotate-90"
        >
          <path
            d="M1 1l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  )
}

/** Properties accepted by the collapsible node body. */
interface WorkflowCanvasNodeBodyProps extends React.ComponentProps<"div"> {}

/**
 * The part of a node that hides while the node is collapsed. Everything
 * outside the body — the header, its `WorkflowCanvasNodeToggle`, the
 * connection handles — stays visible, and edges re-anchor automatically as
 * the node shrinks and grows.
 *
 * @param props - Native container properties.
 * @returns The collapsible content element.
 */
function WorkflowCanvasNodeBody({
  className,
  ...props
}: WorkflowCanvasNodeBodyProps) {
  return (
    <div
      {...props}
      data-slot="workflow-canvas-node-body"
      className={cn(
        "group-data-[collapsed=true]/workflow-node:hidden",
        className,
      )}
    />
  )
}

export {
  WorkflowCanvasNode,
  WorkflowCanvasNodeBody,
  WorkflowCanvasNodeHandle,
  WorkflowCanvasNodeToggle,
  type WorkflowCanvasNodeBodyProps,
  type WorkflowCanvasNodeHandleProps,
  type WorkflowCanvasNodeProps,
  type WorkflowCanvasNodeToggleProps,
  type WorkflowCanvasNodeTrigger,
}
