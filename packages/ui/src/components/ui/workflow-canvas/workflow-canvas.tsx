"use client"

/** @responsibility Renders the pannable, zoomable canvas viewport and orchestrates viewport state, pointer and keyboard navigation, and connection gestures for its nodes and edges. */

import * as React from "react"

import { cn } from "@/lib/utils"

import {
  WorkflowCanvasContext,
  WorkflowCanvasNodeContext,
  WorkflowCanvasViewportContext,
  composeWorkflowCanvasRefs,
  createWorkflowCanvasConnectionStore,
  createWorkflowCanvasGeometryStore,
  useWorkflowCanvasViewport,
  type WorkflowCanvasConnection,
  type WorkflowCanvasConnectionEnd,
  type WorkflowCanvasContextValue,
} from "./workflow-canvas-context"
import {
  clampViewportToBounds,
  nodeAnchorPoint,
  screenPointToCanvasPoint,
  zoomViewportAtPoint,
  type WorkflowCanvasBounds,
  type WorkflowCanvasPoint,
  type WorkflowCanvasViewport,
} from "./workflow-canvas-math"

/**
 * What produced a viewport change: a gesture, or the canvas re-clamping
 * itself into its bounds after mounting or resizing.
 */
type WorkflowCanvasViewportTrigger =
  | "pointer"
  | "wheel"
  | "keyboard"
  | "resize"

/**
 * The background pointers currently steering the viewport, by pointer id.
 * One pointer pans incrementally; two pinch-zoom around their midpoint.
 */
type WorkflowCanvasBackgroundPointers = Map<
  number,
  { clientX: number; clientY: number }
>

/** Properties accepted by the WorkflowCanvas viewport. */
interface WorkflowCanvasProps
  extends Omit<React.ComponentProps<"div">, "onWheel"> {
  /**
   * Called before the canvas pans or zooms on a wheel event. The listener
   * must be non-passive to suppress page scrolling, so it is attached
   * directly to the element and this receives the NATIVE `WheelEvent`
   * rather than React's synthetic one. Call `preventDefault()` to claim
   * the event and leave the viewport untouched.
   */
  onWheel?: (event: WheelEvent) => void
  /**
   * The viewport when the canvas is controlled by its consumer.
   * Interactions report the next viewport through `onViewportChange`; the
   * consumer renders it back through this property.
   */
  viewport?: WorkflowCanvasViewport
  /**
   * Initial viewport for an uncontrolled canvas.
   * @defaultValue `{ x: 0, y: 0, zoom: 1 }`
   */
  defaultViewport?: WorkflowCanvasViewport
  /** Called with the next viewport on every step of an interaction. */
  onViewportChange?: (
    viewport: WorkflowCanvasViewport,
    meta: { trigger: WorkflowCanvasViewportTrigger },
  ) => void
  /**
   * The canvas region panning and node dragging are confined to, in canvas
   * units. Omit for an infinite canvas.
   */
  bounds?: WorkflowCanvasBounds
  /**
   * Smallest allowed zoom.
   * @defaultValue 0.25
   */
  minZoom?: number
  /**
   * Largest allowed zoom.
   * @defaultValue 2
   */
  maxZoom?: number
  /**
   * Screen pixels one arrow-key press pans the focused canvas.
   * @defaultValue 48
   */
  keyboardPanStep?: number
  /**
   * Canvas units one arrow-key press moves a focused node.
   * @defaultValue 8
   */
  keyboardMoveStep?: number
  /** Called when a connection gesture settles between two nodes. */
  onConnect?: (connection: WorkflowCanvasConnection) => void
  /**
   * Called when a drawn connection is released over empty canvas, with the
   * drop point in canvas units — the moment to present follow-up UI there,
   * such as a palette of nodes to create and attach.
   */
  onConnectEnd?: (end: WorkflowCanvasConnectionEnd) => void
  /**
   * Called when the user walks away — pressing the open background, or
   * pressing one of `dismissKeys` anywhere in the canvas. Use it to close
   * transient UI such as a palette opened from `onConnectEnd`.
   */
  onDismiss?: () => void
  /**
   * Keys that trigger `onDismiss`.
   * @defaultValue `["Escape"]`
   */
  dismissKeys?: readonly string[]
  /**
   * Whether the canvas is a read-only view: nodes cannot be dragged, moved
   * with the keyboard, or deleted, connection handles hide and stop
   * drawing, and pointer drags anywhere — nodes included — pan instead.
   * Panning, zooming, resizing, and collapse toggles stay available.
   *
   * Defaults to true for a canvas nested inside another canvas' node (a
   * subflow preview) and false at top level; pass an explicit value to
   * override either way.
   */
  readOnly?: boolean
}

/**
 * An infinite (or bounded) workflow canvas: a pannable, zoomable window onto
 * a plane of nodes and edges.
 *
 * Compose `WorkflowCanvasGrid` for the dotted backdrop, then a
 * `WorkflowCanvasSurface` holding `WorkflowCanvasEdges` and
 * `WorkflowCanvasNode` children. Drag the background or press arrow keys to
 * pan; pinch with two fingers, use a modifier-scroll, or press `+`/`-` to
 * zoom around the pinch midpoint, the pointer, or the center. The canvas is fully controlled when `viewport` is
 * provided; nothing is persisted internally.
 *
 * @param props - Controlled or uncontrolled viewport, zoom range, optional
 * bounds, connection callback, and native container properties.
 * @returns The canvas viewport element providing canvas context.
 */
function WorkflowCanvas({
  viewport: viewportProp,
  defaultViewport,
  onViewportChange,
  bounds,
  minZoom = 0.25,
  maxZoom = 2,
  keyboardPanStep = 48,
  keyboardMoveStep = 8,
  onConnect,
  onConnectEnd,
  onDismiss,
  dismissKeys = ["Escape"],
  readOnly,
  className,
  children,
  ref,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onKeyDown,
  onWheel,
  ...props
}: WorkflowCanvasProps) {
  const rootRef = React.useRef<HTMLDivElement>(null)
  const composedRef = React.useMemo(
    () => composeWorkflowCanvasRefs(rootRef, ref),
    [ref],
  )
  const [geometry] = React.useState(createWorkflowCanvasGeometryStore)
  const [connection] = React.useState(createWorkflowCanvasConnectionStore)
  // A canvas living inside another canvas' node is a subflow preview and
  // presents read-only unless the consumer says otherwise.
  const parentNode = React.useContext(WorkflowCanvasNodeContext)
  const resolvedReadOnly = readOnly ?? parentNode !== null
  const [internalViewport, setInternalViewport] = React.useState<
    WorkflowCanvasViewport
  >(defaultViewport ?? { x: 0, y: 0, zoom: 1 })
  const backgroundPointersRef = React.useRef<WorkflowCanvasBackgroundPointers>(
    new Map(),
  )

  const resolvedViewport = viewportProp ?? internalViewport
  const viewportRef = React.useRef(resolvedViewport)
  viewportRef.current = resolvedViewport
  // What this canvas actually renders, kept apart from the accumulator
  // above so a gesture can re-anchor on it when it resumes.
  // The pointer running a node drag, if any. A node drag lives inside the
  // node, but the canvas must know one is in flight so a second finger on
  // the background cannot pan or dismiss underneath it.
  const nodeDragPointerRef = React.useRef<number | null>(null)
  const renderedViewportRef = React.useRef(resolvedViewport)
  renderedViewportRef.current = resolvedViewport
  const lastWheelTimeRef = React.useRef(0)

  const resolvedBounds = bounds ?? null
  const boundsRef = React.useRef(resolvedBounds)
  boundsRef.current = resolvedBounds
  // A primitive stand-in for the bounds object, so the context value below
  // does not churn when a consumer writes `bounds` inline — which would
  // re-render every node, handle and edge on the canvas.
  const boundsKey = resolvedBounds
    ? `${resolvedBounds.minX},${resolvedBounds.minY},${resolvedBounds.maxX},${resolvedBounds.maxY}`
    : ""

  const callbacksRef = React.useRef({
    onViewportChange,
    onConnect,
    onConnectEnd,
    onDismiss,
    onWheel,
  })
  callbacksRef.current = {
    onViewportChange,
    onConnect,
    onConnectEnd,
    onDismiss,
    onWheel,
  }

  const zoomRangeRef = React.useRef({ minZoom, maxZoom })
  zoomRangeRef.current = { minZoom, maxZoom }

  const isControlledRef = React.useRef(viewportProp !== undefined)
  isControlledRef.current = viewportProp !== undefined

  const isConnecting = React.useSyncExternalStore(
    connection.subscribe,
    () => connection.get() !== null,
    () => false,
  )

  const applyViewport = React.useCallback(
    (next: WorkflowCanvasViewport, trigger: WorkflowCanvasViewportTrigger) => {
      const root = rootRef.current
      const size = root
        ? { width: root.clientWidth, height: root.clientHeight }
        : { width: 0, height: 0 }
      // An unmeasured canvas cannot resolve bound clamping yet; the raw
      // viewport keeps interactions working meanwhile.
      const clamped =
        size.width > 0 && size.height > 0
          ? clampViewportToBounds(next, boundsRef.current, size)
          : next
      const current = viewportRef.current

      if (
        clamped.x === current.x &&
        clamped.y === current.y &&
        clamped.zoom === current.zoom
      ) {
        return
      }

      // The ref always tracks the last viewport this canvas reported, so
      // rapid gesture steps compound instead of re-reading a stale base; a
      // controlled consumer's echo re-anchors it on the next render. The
      // internal state moves solely when the canvas owns its viewport.
      viewportRef.current = clamped

      if (!isControlledRef.current) {
        setInternalViewport(clamped)
      }

      callbacksRef.current.onViewportChange?.(clamped, { trigger })
    },
    [],
  )

  // An ancestor transform (an outer canvas' surface, for example) scales
  // this canvas on screen; every client-pixel measurement divides by this
  // so nested canvases track the pointer exactly.
  const getScreenScale = React.useCallback((): number => {
    const root = rootRef.current

    if (!root || root.offsetWidth === 0) {
      return 1
    }

    const scale = root.getBoundingClientRect().width / root.offsetWidth

    return Number.isFinite(scale) && scale > 0 ? scale : 1
  }, [])

  const clientPointToCanvasPoint = React.useCallback(
    (clientX: number, clientY: number): WorkflowCanvasPoint => {
      const root = rootRef.current
      const rect = root?.getBoundingClientRect()
      const scale = getScreenScale()

      // The surface sits in the root's content box, so a canvas styled
      // with a border starts one border-width inside its rectangle.
      return screenPointToCanvasPoint(
        {
          x: (clientX - (rect?.left ?? 0)) / scale - (root?.clientLeft ?? 0),
          y: (clientY - (rect?.top ?? 0)) / scale - (root?.clientTop ?? 0),
        },
        // The rendered viewport, not the gesture accumulator: pointer
        // coordinates must map against the frame the pointer is over.
        renderedViewportRef.current,
      )
    },
    [getScreenScale],
  )

  const cancelConnection = React.useCallback(() => {
    connection.set(null)
  }, [connection])

  const contextValue = React.useMemo<WorkflowCanvasContextValue>(
    () => ({
      geometry,
      connection,
      // What is on screen — not the accumulator the canvas' own gestures
      // advance — so a controlled consumer that declines a change never
      // has node drags converted at a viewport it rejected.
      getViewport: () => renderedViewportRef.current,
      getRootElement: () => rootRef.current,
      getScreenScale,
      getBounds: () => boundsRef.current,
      boundsKey,
      readOnly: resolvedReadOnly,
      keyboardMoveStep,
      clientPointToCanvasPoint,
      beginConnection: (source, sourceSide, mode) => {
        const sourceGeometry = geometry.get(source)
        const point = sourceGeometry
          ? nodeAnchorPoint(sourceGeometry, sourceSide)
          : { x: 0, y: 0 }

        connection.set({ source, sourceSide, point, mode })
      },
      moveConnection: (clientX, clientY) => {
        const pending = connection.get()

        if (pending) {
          connection.set({
            ...pending,
            point: clientPointToCanvasPoint(clientX, clientY),
          })
        }
      },
      completeConnection: (target, targetSide) => {
        const pending = connection.get()

        connection.set(null)

        // A connection dropped back onto its own node is a cancel, not a
        // self-loop — and a target this canvas has never registered (for
        // example an id from a foreign canvas) can never be reported.
        if (
          pending &&
          pending.source !== target &&
          geometry.get(target) !== undefined
        ) {
          callbacksRef.current.onConnect?.({
            source: pending.source,
            sourceSide: pending.sourceSide,
            target,
            targetSide,
          })
        }
      },
      endConnectionAtPoint: (point) => {
        const pending = connection.get()

        connection.set(null)

        if (pending) {
          callbacksRef.current.onConnectEnd?.({
            source: pending.source,
            sourceSide: pending.sourceSide,
            point,
          })
        }
      },
      cancelConnection,
      claimNodeDrag: (pointerId) => {
        nodeDragPointerRef.current = pointerId
      },
      releaseNodeDrag: (pointerId) => {
        if (nodeDragPointerRef.current === pointerId) {
          nodeDragPointerRef.current = null
        }
      },
      hasNodeDrag: () => nodeDragPointerRef.current !== null,
      revealRegion: (region) => {
        const root = rootRef.current

        if (!root) {
          return
        }

        const current = renderedViewportRef.current
        const margin = 24
        const left = region.x * current.zoom + current.x
        const top = region.y * current.zoom + current.y
        const right = left + region.width * current.zoom
        const bottom = top + region.height * current.zoom
        let { x, y } = current

        // Only the axes that fall outside move, and each moves the least
        // distance that brings the region back inside the window.
        const viewLeft = margin
        const viewRight = root.clientWidth - margin
        const viewTop = margin
        const viewBottom = root.clientHeight - margin

        // A region too large to fit can never sit fully inside, so it
        // counts as revealed while it still covers the window, and only
        // re-anchors to its start edge once it has drifted clear of one —
        // aligning its far edge instead would push a tall node's header,
        // and the controls on it, off screen. Without that hysteresis the
        // oversized case would re-anchor on every keystroke, pinning the
        // node in place while the arrow keys appear to do nothing.
        if (right - left > viewRight - viewLeft) {
          if (left > viewLeft) x += viewLeft - left
          else if (right < viewRight) x -= right - viewRight
        } else if (left < viewLeft) x += viewLeft - left
        else if (right > viewRight) x -= right - viewRight

        if (bottom - top > viewBottom - viewTop) {
          if (top > viewTop) y += viewTop - top
          else if (bottom < viewBottom) y -= bottom - viewBottom
        } else if (top < viewTop) y += viewTop - top
        else if (bottom > viewBottom) y -= bottom - viewBottom

        if (x !== current.x || y !== current.y) {
          applyViewport({ x, y, zoom: current.zoom }, "keyboard")
        }
      },
    }),
    [
      applyViewport,
      cancelConnection,
      clientPointToCanvasPoint,
      connection,
      boundsKey,
      geometry,
      getScreenScale,
      keyboardMoveStep,
      resolvedReadOnly,
    ],
  )

  React.useEffect(() => {
    // A canvas turning read-only walks away from any in-flight connection.
    if (resolvedReadOnly) {
      connection.set(null)
    }
  }, [connection, resolvedReadOnly])

  // A pointer-drawn connection promises Escape as its way out, but the
  // press that started it focused nothing in Safari or Firefox — so while
  // one is in flight, Escape is heard at the document level.
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        cancelConnection()
      }
    }

    let listening = false

    const sync = () => {
      const shouldListen = connection.get()?.mode === "pointer"

      if (shouldListen && !listening) {
        document.addEventListener("keydown", handleKeyDown, true)
        listening = true
      } else if (!shouldListen && listening) {
        document.removeEventListener("keydown", handleKeyDown, true)
        listening = false
      }
    }

    const unsubscribe = connection.subscribe(sync)

    sync()

    return () => {
      unsubscribe()

      if (listening) {
        document.removeEventListener("keydown", handleKeyDown, true)
      }
    }
  }, [cancelConnection, connection])

  // A controlled viewport arrives outside any gesture, so bounds would
  // otherwise never touch it: the canvas would render out-of-bounds space
  // until the first gesture snapped it back. Re-clamping on every change
  // corrects the consumer's state through onViewportChange instead. Only
  // an actually out-of-bounds render applies anything — re-applying an
  // in-bounds one would stomp gesture steps still accumulating between
  // renders.
  React.useEffect(() => {
    const root = rootRef.current

    if (!root) {
      return
    }

    const size = { width: root.clientWidth, height: root.clientHeight }

    if (size.width <= 0 || size.height <= 0) {
      return
    }

    const rendered = renderedViewportRef.current
    const { minZoom: min, maxZoom: max } = zoomRangeRef.current

    // Zoom is policed on arrival too, anchored at the middle so the
    // correction reads as a zoom about the centre rather than a jump.
    // Left to the gesture handlers alone, an out-of-range controlled zoom
    // would render as given and snap on the first wheel tick.
    const inRange =
      rendered.zoom < min || rendered.zoom > max
        ? zoomViewportAtPoint(
            rendered,
            { x: size.width / 2, y: size.height / 2 },
            rendered.zoom,
            min,
            max,
          )
        : rendered
    const clamped = clampViewportToBounds(inRange, boundsRef.current, size)

    if (
      clamped.x !== rendered.x ||
      clamped.y !== rendered.y ||
      clamped.zoom !== rendered.zoom
    ) {
      applyViewport(clamped, "resize")
    }
  }, [
    applyViewport,
    boundsKey,
    resolvedViewport.x,
    resolvedViewport.y,
    resolvedViewport.zoom,
  ])

  React.useEffect(() => {
    const root = rootRef.current

    if (!root || typeof ResizeObserver === "undefined") {
      return
    }

    // Bounds otherwise apply only to what an interaction produces, so an
    // initial viewport could start outside them and a resized canvas could
    // reveal space beyond them until the next gesture. Re-clamping on
    // mount and on every resize keeps the window inside its region.
    const clampToBounds = () => {
      applyViewport(viewportRef.current, "resize")
    }

    clampToBounds()

    const observer = new ResizeObserver(clampToBounds)

    observer.observe(root)

    return () => observer.disconnect()
  }, [applyViewport, boundsKey])

  React.useEffect(() => {
    const root = rootRef.current

    if (!root) {
      return
    }

    // Reads whether an element between the wheel target and the canvas
    // root can consume the scroll itself — an overflowing list inside a
    // node, an editable field — so the canvas leaves those wheels alone.
    const contentConsumesWheel = (
      target: EventTarget | null,
      event: WheelEvent,
    ): boolean => {
      let element = target instanceof Element ? target : null

      while (element && element !== root) {
        if (
          element.matches(
            'input, textarea, select, [contenteditable="true"], [data-workflow-canvas-no-drag]',
          )
        ) {
          return true
        }

        if (element instanceof HTMLElement) {
          const style = getComputedStyle(element)
          const scrollsY =
            /(auto|scroll)/.test(style.overflowY) &&
            element.scrollHeight > element.clientHeight
          const scrollsX =
            /(auto|scroll)/.test(style.overflowX) &&
            element.scrollWidth > element.clientWidth

          if (
            (event.deltaY !== 0 && scrollsY) ||
            (event.deltaX !== 0 && scrollsX)
          ) {
            return true
          }
        }

        element = element.parentElement
      }

      return false
    }

    // React registers wheel listeners passively, which cannot suppress the
    // page scrolling underneath the canvas, so the listener is attached
    // directly to the canvas element instead. The consumer's onWheel still
    // runs first and may preventDefault to claim the event.
    const handleWheel = (event: WheelEvent) => {
      if (contentConsumesWheel(event.target, event)) {
        return
      }

      // Wheel deltas only arrive in pixels from DOM_DELTA_PIXEL devices;
      // Firefox reports lines and page-scroll wheels report pages, so both
      // are converted before any of the transform math sees them.
      const deltaScale =
        event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? root.clientHeight : 1
      const deltaX = event.deltaX * deltaScale
      const deltaY = event.deltaY * deltaScale

      // A wheel burst compounds from the viewport this canvas last
      // reported, but a burst arriving after a pause re-anchors on the
      // rendered viewport — so a controlled consumer that declines a
      // change is never accumulated against a viewport it rejected.
      const now = performance.now()

      if (now - lastWheelTimeRef.current > 150) {
        viewportRef.current = renderedViewportRef.current
      }

      lastWheelTimeRef.current = now

      callbacksRef.current.onWheel?.(event)

      if (event.defaultPrevented) {
        return
      }

      event.preventDefault()
      event.stopPropagation()

      const current = viewportRef.current
      const scale = getScreenScale()

      if (event.ctrlKey || event.metaKey) {
        const rect = root.getBoundingClientRect()
        const { minZoom: min, maxZoom: max } = zoomRangeRef.current

        applyViewport(
          zoomViewportAtPoint(
            current,
            {
              x: (event.clientX - rect.left) / scale - root.clientLeft,
              y: (event.clientY - rect.top) / scale - root.clientTop,
            },
            // A gentle exponent keeps one wheel notch to roughly a fifth
            // of a zoom step instead of crossing the whole range at once.
            current.zoom * Math.exp(-deltaY * 0.002),
            min,
            max,
          ),
          "wheel",
        )
      } else {
        applyViewport(
          {
            x: current.x - deltaX / scale,
            y: current.y - deltaY / scale,
            zoom: current.zoom,
          },
          "wheel",
        )
      }
    }

    root.addEventListener("wheel", handleWheel, { passive: false })

    return () => root.removeEventListener("wheel", handleWheel)
  }, [applyViewport, getScreenScale])

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    onPointerDown?.(event)
    // The canvas isolates its pointer gestures so a canvas nested inside a
    // node never pans or drags its host.
    event.stopPropagation()

    if (event.defaultPrevented || event.button !== 0) {
      return
    }

    const target = event.target as Element

    // Nodes, handles, interactive edges, and interactive elements own their
    // gestures; only the open background pans. On a read-only canvas nodes
    // and edges give up their gestures, so panning works from anywhere that
    // is not a control.
    if (
      target.closest(
        resolvedReadOnly
          ? 'button, a, input, textarea, select, [contenteditable="true"], [data-workflow-canvas-no-drag]'
          : '[data-slot="workflow-canvas-node"], [data-slot="workflow-canvas-handle"], [data-slot="workflow-canvas-edge"], button, a, input, textarea, select, [contenteditable="true"], [data-workflow-canvas-no-drag]',
      )
    ) {
      return
    }

    const pending = connection.get()

    // A connection or node drag a pointer is actively running belongs to
    // that pointer alone: a second finger landing on the background must
    // not destroy it, dismiss anything, or start panning underneath it —
    // a pan would slide the plane out from under the held node, which
    // tracks only its own finger's travel.
    if (pending?.mode === "pointer" || nodeDragPointerRef.current !== null) {
      return
    }

    // Pressing the open background walks away from whatever is in flight: a
    // connection someone armed but never finished, and any transient UI
    // the consumer has open.
    if (pending !== null) {
      cancelConnection()
    }

    callbacksRef.current.onDismiss?.()

    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Synthetic pointer events (tests) have no capturable pointer id;
      // panning still works through the element's own move events.
    }

    // A new gesture starts from what the canvas actually renders, so a
    // controlled consumer that declined the last change is never panned
    // against a viewport it rejected.
    if (backgroundPointersRef.current.size === 0) {
      viewportRef.current = renderedViewportRef.current
    }

    backgroundPointersRef.current.set(event.pointerId, {
      clientX: event.clientX,
      clientY: event.clientY,
    })
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    onPointerMove?.(event)

    const pointers = backgroundPointersRef.current
    const previous = pointers.get(event.pointerId)

    if (!previous) {
      return
    }

    const scale = getScreenScale()
    const current = viewportRef.current

    if (pointers.size === 1) {
      // One background pointer pans, incrementally: each step folds in any
      // viewport change that landed between moves (a wheel zoom, a
      // controlled update) instead of overwriting it.
      applyViewport(
        {
          x: current.x + (event.clientX - previous.clientX) / scale,
          y: current.y + (event.clientY - previous.clientY) / scale,
          zoom: current.zoom,
        },
        "pointer",
      )
    } else if (pointers.size === 2) {
      // Two background pointers pinch: zoom follows their spread, anchored
      // at the midpoint's previous position, while the midpoint's travel
      // pans — so the canvas point held between the fingers stays held.
      const other = [...pointers.entries()].find(
        ([pointerId]) => pointerId !== event.pointerId,
      )?.[1]

      if (other) {
        const rect = event.currentTarget.getBoundingClientRect()
        const previousDistance = Math.hypot(
          previous.clientX - other.clientX,
          previous.clientY - other.clientY,
        )
        const nextDistance = Math.hypot(
          event.clientX - other.clientX,
          event.clientY - other.clientY,
        )
        const previousMid = {
          x: (previous.clientX + other.clientX) / 2,
          y: (previous.clientY + other.clientY) / 2,
        }
        const nextMid = {
          x: (event.clientX + other.clientX) / 2,
          y: (event.clientY + other.clientY) / 2,
        }
        const { minZoom: min, maxZoom: max } = zoomRangeRef.current
        // The zoom anchors where the midpoint WAS: the separate travel
        // term below then carries that point to where the fingers are now.
        // Anchoring at the new midpoint instead would fold the travel into
        // the scaled term and count it twice.
        const zoomed = zoomViewportAtPoint(
          current,
          {
            x:
              (previousMid.x - rect.left) / scale -
              event.currentTarget.clientLeft,
            y:
              (previousMid.y - rect.top) / scale -
              event.currentTarget.clientTop,
          },
          current.zoom * (nextDistance / Math.max(previousDistance, 1e-6)),
          min,
          max,
        )

        applyViewport(
          {
            x: zoomed.x + (nextMid.x - previousMid.x) / scale,
            y: zoomed.y + (nextMid.y - previousMid.y) / scale,
            zoom: zoomed.zoom,
          },
          "pointer",
        )
      }
    }

    pointers.set(event.pointerId, {
      clientX: event.clientX,
      clientY: event.clientY,
    })
  }

  const handlePointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (backgroundPointersRef.current.delete(event.pointerId)) {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event)

    if (event.defaultPrevented) {
      return
    }

    // Escape always abandons a pending connection first; a second press (or
    // any configured dismiss key) then reaches the consumer's transient UI.
    if (event.key === "Escape" && connection.get() !== null) {
      event.preventDefault()
      event.stopPropagation()
      cancelConnection()
      return
    }

    if (dismissKeys.includes(event.key) && callbacksRef.current.onDismiss) {
      event.preventDefault()
      event.stopPropagation()

      // The dismissal may unmount the very element holding focus (a
      // palette option, for example). If it does, the canvas takes focus —
      // matching the delete paths — but an Escape that closes something
      // elsewhere leaves the focused field alone.
      const root = rootRef.current
      const activeBefore =
        root && root.contains(document.activeElement)
          ? document.activeElement
          : null

      callbacksRef.current.onDismiss()

      if (activeBefore) {
        queueMicrotask(() => {
          if (!activeBefore.isConnected) {
            rootRef.current?.focus()
          }
        })
      }

      return
    }

    // Navigation keys act on the canvas itself, never on a focused node or
    // control inside it.
    if (event.target !== event.currentTarget) {
      return
    }

    // Keyboard steps start from what is rendered, the way pointer and
    // wheel gestures re-anchor, so a controlled consumer that declines a
    // change never leaves later key presses computing against a phantom.
    viewportRef.current = renderedViewportRef.current

    const current = viewportRef.current
    const step = keyboardPanStep
    let next: WorkflowCanvasViewport | undefined

    switch (event.key) {
      case "ArrowLeft":
        next = { ...current, x: current.x + step }
        break
      case "ArrowRight":
        next = { ...current, x: current.x - step }
        break
      case "ArrowUp":
        next = { ...current, y: current.y + step }
        break
      case "ArrowDown":
        next = { ...current, y: current.y - step }
        break
      case "+":
      case "=":
      case "-": {
        const root = rootRef.current
        const center = root
          ? { x: root.clientWidth / 2, y: root.clientHeight / 2 }
          : { x: 0, y: 0 }
        const factor = event.key === "-" ? 1 / 1.2 : 1.2

        next = zoomViewportAtPoint(
          current,
          center,
          current.zoom * factor,
          minZoom,
          maxZoom,
        )
        break
      }
    }

    if (next) {
      event.preventDefault()
      event.stopPropagation()
      applyViewport(next, "keyboard")
    }
  }

  return (
    <WorkflowCanvasContext.Provider value={contextValue}>
      <WorkflowCanvasViewportContext.Provider value={resolvedViewport}>
        {/* Consumer props spread first so the attributes the canvas owns
            (slot, role, gesture handlers) always win. */}
        <div
          role="application"
          tabIndex={0}
          {...props}
          ref={composedRef}
          data-slot="workflow-canvas"
          data-connecting={isConnecting ? "true" : undefined}
          data-readonly={resolvedReadOnly ? "true" : undefined}
          className={cn(
            // overflow-clip (not hidden) so the browser can never scroll
            // the clipped root to reveal a focused off-screen node, which
            // would silently desync every coordinate conversion.
            "group/workflow-canvas relative isolate box-border block h-full w-full touch-none select-none overflow-clip bg-background",
            "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
            className,
          )}
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
          onKeyDown={handleKeyDown}
          onBlur={(event) => {
            props.onBlur?.(event)

            // Focus leaving the canvas entirely retires a keyboard-armed
            // connection, which otherwise waits indefinitely and would be
            // completed by an unrelated handle press much later.
            if (
              connection.get()?.mode === "keyboard" &&
              !event.currentTarget.contains(event.relatedTarget as Node | null)
            ) {
              cancelConnection()
            }
          }}
        >
          {children}
        </div>
      </WorkflowCanvasViewportContext.Provider>
    </WorkflowCanvasContext.Provider>
  )
}

/** Properties accepted by the canvas dot-grid backdrop. */
interface WorkflowCanvasGridProps extends React.ComponentProps<"div"> {
  /**
   * Canvas units between grid dots.
   * @defaultValue 24
   */
  gridSize?: number
}

/**
 * The dotted backdrop of a workflow canvas. The dots track the viewport, so
 * panning and zooming read as movement over an endless surface.
 *
 * @param props - The grid spacing and native container properties.
 * @returns A non-interactive full-bleed backdrop layer.
 */
function WorkflowCanvasGrid({
  gridSize = 24,
  className,
  style,
  ...props
}: WorkflowCanvasGridProps) {
  const viewport = useWorkflowCanvasViewport("WorkflowCanvasGrid")
  const spacing = gridSize * viewport.zoom

  return (
    <div
      aria-hidden="true"
      {...props}
      data-slot="workflow-canvas-grid"
      className={cn(
        "pointer-events-none absolute inset-0 [background-image:radial-gradient(circle,var(--border)_1px,transparent_1.5px)] [background-size:var(--workflow-canvas-grid-spacing)_var(--workflow-canvas-grid-spacing)] [background-position:var(--workflow-canvas-grid-x)_var(--workflow-canvas-grid-y)]",
        className,
      )}
      style={{
        "--workflow-canvas-grid-spacing": `${spacing}px`,
        "--workflow-canvas-grid-x": `${viewport.x}px`,
        "--workflow-canvas-grid-y": `${viewport.y}px`,
        ...style,
      } as React.CSSProperties}
    />
  )
}

/** Properties accepted by the transformed canvas surface. */
interface WorkflowCanvasSurfaceProps extends React.ComponentProps<"div"> {}

/**
 * The plane nodes and edges live on. The surface carries the viewport
 * transform as a single style, so panning and zooming never re-render the
 * nodes inside it.
 *
 * @param props - Native container properties; children are the canvas'
 * edges and nodes.
 * @returns The transformed content layer.
 */
function WorkflowCanvasSurface({
  className,
  style,
  ...props
}: WorkflowCanvasSurfaceProps) {
  const viewport = useWorkflowCanvasViewport("WorkflowCanvasSurface")

  return (
    <div
      {...props}
      data-slot="workflow-canvas-surface"
      className={cn(
        "absolute top-0 left-0 origin-top-left will-change-transform",
        className,
      )}
      style={
        {
          ...style,
          // The viewport transform composes with — never yields to — a
          // transform the consumer styles on.
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})${
            typeof style?.transform === "string" ? ` ${style.transform}` : ""
          }`,
          // Published for descendants that must keep a constant SCREEN
          // size under this scale — the edge grab band, for one. SVG's
          // vector-effect cannot do it: the zoom is a CSS transform on an
          // HTML ancestor, outside the SVG's own coordinate chain.
          "--nessa-workflow-canvas-zoom": String(viewport.zoom),
        } as React.CSSProperties
      }
    />
  )
}

export {
  WorkflowCanvas,
  WorkflowCanvasGrid,
  WorkflowCanvasSurface,
  type WorkflowCanvasGridProps,
  type WorkflowCanvasProps,
  type WorkflowCanvasSurfaceProps,
  type WorkflowCanvasViewportTrigger,
}
