import * as React from "react"

import type {
  WorkflowCanvasBounds,
  WorkflowCanvasNodeGeometry,
  WorkflowCanvasPoint,
  WorkflowCanvasSide,
  WorkflowCanvasViewport,
} from "./workflow-canvas-math"

/** A finished connection gesture reported to the canvas consumer. */
interface WorkflowCanvasConnection {
  /** The node the connection started from. */
  source: string
  /** The side the connection left the source node on. */
  sourceSide: WorkflowCanvasSide
  /** The node the connection was dropped on. */
  target: string
  /** The side the connection attached to on the target node. */
  targetSide: WorkflowCanvasSide
}

/** A connection gesture released over empty canvas instead of a node. */
interface WorkflowCanvasConnectionEnd {
  /** The node the gesture started from. */
  source: string
  /** The side the gesture left the source node on. */
  sourceSide: WorkflowCanvasSide
  /** Where the gesture was released, in canvas units. */
  point: WorkflowCanvasPoint
}

/** The in-flight state of a connection gesture while it is being drawn. */
interface WorkflowCanvasPendingConnection {
  /** The node the gesture started from. */
  source: string
  /** The side the gesture left the source node on. */
  sourceSide: WorkflowCanvasSide
  /** Where the free end of the connection line currently sits, in canvas units. */
  point: WorkflowCanvasPoint
  /** Whether a pointer or the keyboard is drawing the gesture. */
  mode: "pointer" | "keyboard"
}

/**
 * A subscription store holding one value per node id. Listeners subscribe to
 * a single id, so moving one node re-renders only that node and the edges
 * attached to it — never the rest of the graph.
 */
interface WorkflowCanvasGeometryStore {
  /** Reads one node's geometry; stable by reference until it changes. */
  get: (id: string) => WorkflowCanvasNodeGeometry | undefined
  /** Replaces one node's position, keeping its measured size. */
  setPosition: (id: string, x: number, y: number) => void
  /** Replaces one node's measured size, keeping its position. */
  setSize: (id: string, width: number, height: number) => void
  /** Removes one node's geometry when it unmounts. */
  remove: (id: string) => void
  /** Subscribes to one node's geometry; returns the disposer. */
  subscribe: (id: string, listener: () => void) => () => void
}

/**
 * Builds the geometry store backing one canvas.
 *
 * @returns A fresh, empty geometry store.
 */
function createWorkflowCanvasGeometryStore(): WorkflowCanvasGeometryStore {
  const geometries = new Map<string, WorkflowCanvasNodeGeometry>()
  const listeners = new Map<string, Set<() => void>>()

  const notify = (id: string) => {
    const bucket = listeners.get(id)

    if (bucket) {
      for (const listener of bucket) listener()
    }
  }

  return {
    get: (id) => geometries.get(id),
    setPosition: (id, x, y) => {
      const current = geometries.get(id)

      if (current && current.x === x && current.y === y) {
        return
      }

      geometries.set(id, {
        x,
        y,
        width: current?.width ?? 0,
        height: current?.height ?? 0,
      })
      notify(id)
    },
    setSize: (id, width, height) => {
      const current = geometries.get(id)

      if (current && current.width === width && current.height === height) {
        return
      }

      geometries.set(id, {
        x: current?.x ?? 0,
        y: current?.y ?? 0,
        width,
        height,
      })
      notify(id)
    },
    remove: (id) => {
      if (geometries.delete(id)) {
        notify(id)
      }
    },
    subscribe: (id, listener) => {
      let bucket = listeners.get(id)

      if (!bucket) {
        bucket = new Set()
        listeners.set(id, bucket)
      }

      bucket.add(listener)

      return () => {
        bucket.delete(listener)

        if (bucket.size === 0) {
          listeners.delete(id)
        }
      }
    },
  }
}

/**
 * A single-value subscription store for the in-flight connection gesture, so
 * only the connection line and interested handles re-render while it moves.
 */
interface WorkflowCanvasConnectionStore {
  /** Reads the pending connection; stable by reference until it changes. */
  get: () => WorkflowCanvasPendingConnection | null
  /** Replaces the pending connection. */
  set: (connection: WorkflowCanvasPendingConnection | null) => void
  /** Subscribes to pending-connection changes; returns the disposer. */
  subscribe: (listener: () => void) => () => void
}

/**
 * Builds the connection store backing one canvas.
 *
 * @returns A fresh store with no pending connection.
 */
function createWorkflowCanvasConnectionStore(): WorkflowCanvasConnectionStore {
  let connection: WorkflowCanvasPendingConnection | null = null
  const listeners = new Set<() => void>()

  return {
    get: () => connection,
    set: (next) => {
      if (next === connection) {
        return
      }

      connection = next

      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** Shared state and actions provided by one WorkflowCanvas. */
interface WorkflowCanvasContextValue {
  /** Per-node geometry with targeted subscriptions. */
  geometry: WorkflowCanvasGeometryStore
  /** The in-flight connection gesture. */
  connection: WorkflowCanvasConnectionStore
  /** Reads the current viewport without subscribing to it. */
  getViewport: () => WorkflowCanvasViewport
  /** Reads the canvas' root element, or null before mount. */
  getRootElement: () => HTMLElement | null
  /**
   * Reads how many screen pixels one canvas-element pixel currently spans —
   * greater than 1 when an ancestor (such as an outer canvas' surface)
   * scales this canvas. Pointer deltas divide by this before use.
   */
  getScreenScale: () => number
  /**
   * Reads the canvas bounds without subscribing to them. Bounds are read
   * imperatively inside handlers, so keeping them out of the context value
   * lets that value stay identity-stable even when a consumer writes
   * `bounds` as an inline object literal.
   */
  getBounds: () => WorkflowCanvasBounds | null
  /**
   * A primitive fingerprint of the current bounds, for effects that must
   * re-run when the bounds genuinely change rather than whenever a fresh
   * object carrying the same numbers arrives.
   */
  boundsKey: string
  /**
   * Whether the canvas is a read-only view: nodes cannot be dragged, moved,
   * or deleted and connections cannot be drawn, while panning, zooming, and
   * collapsing stay available.
   */
  readOnly: boolean
  /** Canvas units one arrow-key press moves a focused node. */
  keyboardMoveStep: number
  /** Converts client (viewport) coordinates into canvas-plane coordinates. */
  clientPointToCanvasPoint: (
    clientX: number,
    clientY: number,
  ) => WorkflowCanvasPoint
  /** Starts a connection gesture from one node side. */
  beginConnection: (
    source: string,
    sourceSide: WorkflowCanvasSide,
    mode: "pointer" | "keyboard",
  ) => void
  /** Moves the free end of the pending connection to a client point. */
  moveConnection: (clientX: number, clientY: number) => void
  /** Settles the pending connection onto a target node and side. */
  completeConnection: (target: string, targetSide: WorkflowCanvasSide) => void
  /**
   * Releases the pending connection over empty canvas, reporting the drop
   * point to the canvas consumer.
   */
  endConnectionAtPoint: (point: WorkflowCanvasPoint) => void
  /** Abandons the pending connection. */
  cancelConnection: () => void
  /**
   * Pans the viewport, if needed, until the given canvas-plane region sits
   * inside the visible window — how a node keeps focus on screen when the
   * clipped canvas cannot scroll itself.
   */
  /**
   * Claims the board for a node drag the given pointer is running, so the
   * canvas leaves that gesture alone: a second finger landing on the
   * background must not dismiss anything or pan underneath it.
   */
  claimNodeDrag: (pointerId: number) => void
  /** Releases a claim made by `claimNodeDrag`. */
  releaseNodeDrag: (pointerId: number) => void
  /** Whether a node drag currently owns the board. */
  hasNodeDrag: () => boolean
  revealRegion: (region: {
    x: number
    y: number
    width: number
    height: number
  }) => void
}

const WorkflowCanvasContext =
  React.createContext<WorkflowCanvasContextValue | null>(null)

/** The viewport currently rendered by the nearest WorkflowCanvas. */
const WorkflowCanvasViewportContext =
  React.createContext<WorkflowCanvasViewport | null>(null)

/** The node a handle, toggle, or body part belongs to. */
interface WorkflowCanvasNodeContextValue {
  /** The owning node's id. */
  nodeId: string
  /** Whether the node currently presents collapsed. */
  collapsed: boolean
  /** Moves the node between collapsed and expanded. */
  setCollapsed: (collapsed: boolean) => void
  /**
   * Whether THIS node is hovered or holds focus — the node's own state,
   * never an ancestor's. A CSS group selector matches any ancestor with
   * the group class, which would reveal a nested canvas' handles whenever
   * the host node containing that canvas was hovered.
   */
  revealed: boolean
}

const WorkflowCanvasNodeContext =
  React.createContext<WorkflowCanvasNodeContextValue | null>(null)

/**
 * Reads the coordination state of the nearest WorkflowCanvas.
 *
 * @param consumer - The component name reported when used outside a canvas.
 * @returns The current canvas context value.
 * @throws When called outside a WorkflowCanvas.
 */
function useWorkflowCanvas(consumer: string): WorkflowCanvasContextValue {
  const context = React.useContext(WorkflowCanvasContext)

  if (context === null) {
    throw new Error(`${consumer} must be used within a WorkflowCanvas.`)
  }

  return context
}

/**
 * Reads the viewport currently rendered by the nearest WorkflowCanvas.
 * Subscribes the caller to every pan and zoom step.
 *
 * @param consumer - The component name reported when used outside a canvas.
 * @returns The current viewport.
 * @throws When called outside a WorkflowCanvas.
 */
function useWorkflowCanvasViewport(consumer: string): WorkflowCanvasViewport {
  const viewport = React.useContext(WorkflowCanvasViewportContext)

  if (viewport === null) {
    throw new Error(`${consumer} must be used within a WorkflowCanvas.`)
  }

  return viewport
}

/**
 * Subscribes to one node's geometry, re-rendering the caller only when that
 * node moves or resizes.
 *
 * @param id - The node id to watch.
 * @returns The node's geometry, or undefined before the node registers.
 */
function useWorkflowCanvasNodeGeometry(
  id: string,
): WorkflowCanvasNodeGeometry | undefined {
  const { geometry } = useWorkflowCanvas("useWorkflowCanvasNodeGeometry")
  const subscribe = React.useCallback(
    (listener: () => void) => geometry.subscribe(id, listener),
    [geometry, id],
  )

  return React.useSyncExternalStore(
    subscribe,
    () => geometry.get(id),
    () => undefined,
  )
}

/**
 * Subscribes to the in-flight connection gesture, re-rendering the caller
 * only while a connection is being drawn.
 *
 * @returns The pending connection, or null when none is active.
 */
function useWorkflowCanvasPendingConnection(): WorkflowCanvasPendingConnection | null {
  const { connection } = useWorkflowCanvas("useWorkflowCanvasPendingConnection")

  return React.useSyncExternalStore(
    connection.subscribe,
    connection.get,
    () => null,
  )
}

/**
 * Builds one ref callback that feeds an element to our internal ref and to
 * a ref the consumer may have passed, so neither side loses it.
 *
 * @param internal - The component's own element ref.
 * @param forwarded - The consumer's ref, if any.
 * @returns A ref callback serving both.
 */
function composeWorkflowCanvasRefs<Element>(
  internal: React.RefObject<Element | null>,
  forwarded: React.Ref<Element> | undefined,
): React.RefCallback<Element> {
  return (element) => {
    internal.current = element

    if (typeof forwarded === "function") {
      const cleanup = forwarded(element)

      // A consumer ref returning a cleanup (React 19) never receives a
      // null call, so the composed ref honours the same contract.
      if (typeof cleanup === "function") {
        return () => {
          internal.current = null
          cleanup()
        }
      }
    } else if (forwarded) {
      forwarded.current = element
    }
  }
}

export {
  WorkflowCanvasContext,
  WorkflowCanvasNodeContext,
  WorkflowCanvasViewportContext,
  composeWorkflowCanvasRefs,
  createWorkflowCanvasConnectionStore,
  createWorkflowCanvasGeometryStore,
  useWorkflowCanvas,
  useWorkflowCanvasNodeGeometry,
  useWorkflowCanvasPendingConnection,
  useWorkflowCanvasViewport,
  type WorkflowCanvasConnection,
  type WorkflowCanvasConnectionEnd,
  type WorkflowCanvasConnectionStore,
  type WorkflowCanvasContextValue,
  type WorkflowCanvasGeometryStore,
  type WorkflowCanvasNodeContextValue,
  type WorkflowCanvasPendingConnection,
}
