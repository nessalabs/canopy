"use client"

/** @responsibility Renders the edge layer of a workflow canvas: declarative edges that follow their endpoint nodes with auto-aligned sides, optional interactivity and selection, and the live line drawn while a connection gesture is in flight. */

import * as React from "react"

import { cn } from "@/lib/utils"

import {
  useWorkflowCanvas,
  useWorkflowCanvasNodeGeometry,
  useWorkflowCanvasPendingConnection,
} from "./workflow-canvas-context"
import {
  edgeMidpoint,
  edgePath,
  nearestNodeSide,
  nodeAnchorPoint,
  preferredEdgeSides,
  type WorkflowCanvasPoint,
  type WorkflowCanvasSide,
} from "./workflow-canvas-math"

/** The resolved drawing geometry of one edge. */
interface WorkflowCanvasEdgeGeometry {
  /** The SVG path definition of the edge's curve. */
  path: string
  /** Where the edge leaves the source node, in canvas units. */
  sourceAnchor: WorkflowCanvasPoint
  /** Where the edge enters the target node, in canvas units. */
  targetAnchor: WorkflowCanvasPoint
  /** The point halfway along the curve, where labels sit naturally. */
  midpoint: WorkflowCanvasPoint
  /** The side the edge actually leaves from after auto-alignment. */
  sourceSide: WorkflowCanvasSide
  /** The side the edge actually arrives at after auto-alignment. */
  targetSide: WorkflowCanvasSide
}

/** Endpoint options resolved into edge geometry. */
interface WorkflowCanvasEdgeOptions {
  /** The id of the node the edge starts from. */
  source: string
  /** The id of the node the edge ends at. */
  target: string
  /** A fixed source side; omit to let auto-alignment pick one. */
  sourceSide?: WorkflowCanvasSide
  /** A fixed target side; omit to let auto-alignment pick one. */
  targetSide?: WorkflowCanvasSide
  /**
   * Whether unset sides follow the nodes' relative positions, so an edge
   * always takes the most direct route and re-routes as nodes move. Turn
   * off to pin unset sides to the static right-to-left default.
   * @defaultValue true
   */
  autoAlign?: boolean
}

/**
 * Resolves one edge's live drawing geometry, subscribing to just its two
 * endpoint nodes. Build fully custom edge presentations on top of this —
 * anything that can render SVG or a positioned element can be an edge.
 *
 * @param options - The endpoint node ids, optional fixed sides, and the
 * auto-alignment switch.
 * @returns The edge geometry, or undefined until both endpoints are
 * mounted.
 */
function useWorkflowCanvasEdgeGeometry(
  options: WorkflowCanvasEdgeOptions,
): WorkflowCanvasEdgeGeometry | undefined {
  const { source, target, sourceSide, targetSide, autoAlign = true } = options
  const sourceGeometry = useWorkflowCanvasNodeGeometry(source)
  const targetGeometry = useWorkflowCanvasNodeGeometry(target)

  if (!sourceGeometry || !targetGeometry) {
    return undefined
  }

  const preferred = autoAlign
    ? preferredEdgeSides(sourceGeometry, targetGeometry)
    : undefined
  const resolvedSourceSide = sourceSide ?? preferred?.sourceSide ?? "right"
  const resolvedTargetSide = targetSide ?? preferred?.targetSide ?? "left"
  const sourceAnchor = nodeAnchorPoint(sourceGeometry, resolvedSourceSide)
  const targetAnchor = nodeAnchorPoint(targetGeometry, resolvedTargetSide)

  return {
    path: edgePath(
      sourceAnchor,
      resolvedSourceSide,
      targetAnchor,
      resolvedTargetSide,
    ),
    sourceAnchor,
    targetAnchor,
    midpoint: edgeMidpoint(
      sourceAnchor,
      resolvedSourceSide,
      targetAnchor,
      resolvedTargetSide,
    ),
    sourceSide: resolvedSourceSide,
    targetSide: resolvedTargetSide,
  }
}

/** Properties accepted by the canvas edge layer. */
interface WorkflowCanvasEdgesProps extends React.ComponentProps<"svg"> {
  /**
   * The element drawn while a connection gesture is in flight. Pass a
   * styled `WorkflowCanvasConnectionLine` (or any component reading
   * `useWorkflowCanvasPendingConnection`) to restyle it.
   * @defaultValue `<WorkflowCanvasConnectionLine />`
   */
  connectionLine?: React.ReactNode
}

/**
 * The layer edges draw on. Place it inside a `WorkflowCanvasSurface`
 * alongside the nodes — typically before them, so edges run underneath —
 * and compose `WorkflowCanvasEdge` children inside it. The layer also draws
 * the live connection line while one is being dragged from a handle.
 *
 * @param props - Native SVG properties, an optional custom connection line,
 * and the canvas' edges as children.
 * @returns The edge layer element.
 */
function WorkflowCanvasEdges({
  connectionLine,
  className,
  children,
  ...props
}: WorkflowCanvasEdgesProps) {
  return (
    <svg
      width="1"
      height="1"
      {...props}
      data-slot="workflow-canvas-edges"
      className={cn(
        "pointer-events-none absolute top-0 left-0 overflow-visible",
        className,
      )}
    >
      {children}
      {connectionLine ?? <WorkflowCanvasConnectionLine />}
    </svg>
  )
}

/** Properties accepted by one canvas edge. */
interface WorkflowCanvasEdgeProps
  extends Omit<React.ComponentProps<"g">, "children" | "target">,
    WorkflowCanvasEdgeOptions {
  /** Whether the edge presents as selected. */
  selected?: boolean
  /**
   * Whether the edge takes pointer and keyboard interaction: a wide invisible
   * hit area along the curve, a button role, and focusability. Defaults to
   * on exactly when `onClick` or `onDelete` is provided.
   */
  interactive?: boolean
  /**
   * Called when Delete or Backspace is pressed on the focused edge — the
   * moment to remove it from consumer state.
   */
  onDelete?: () => void
  /** Custom SVG content drawn on top of the line — markers, labels, badges. */
  children?: React.ReactNode
  /** Class for the visible line itself; the other properties land on the group. */
  className?: string
}

/**
 * One edge between two nodes. The edge subscribes to just its two endpoint
 * nodes, so it re-renders while either of them moves or resizes and stays
 * inert the rest of the time — even on canvases with thousands of nodes.
 *
 * Sides auto-align by default: the edge leaves and enters whichever facing
 * sides connect the nodes most directly, re-routing live as nodes move.
 * Pass `sourceSide`/`targetSide` to pin a side, or `autoAlign={false}` for
 * the static right-to-left default. With `onClick` (or `interactive`) the
 * edge becomes a focusable button with a generous hit area along the curve;
 * pair it with `selected` to present selection. Style the line through
 * `className`; render custom SVG decorations as children, or build a fully
 * custom edge with `useWorkflowCanvasEdgeGeometry`.
 *
 * The edge renders nothing until both endpoints are mounted, so edges and
 * nodes can be declared in any order.
 *
 * @param props - The endpoint node ids, side and alignment options,
 * selection and interactivity state, and native group properties.
 * @returns The edge group element, or nothing while an endpoint is missing.
 */
function WorkflowCanvasEdge({
  source,
  target,
  sourceSide,
  targetSide,
  autoAlign,
  selected,
  interactive,
  onDelete,
  className,
  children,
  onClick,
  onKeyDown,
  ...props
}: WorkflowCanvasEdgeProps) {
  const { readOnly, getRootElement } = useWorkflowCanvas("WorkflowCanvasEdge")
  const geometry = useWorkflowCanvasEdgeGeometry({
    source,
    target,
    sourceSide,
    targetSide,
    autoAlign,
  })

  if (!geometry) {
    return null
  }

  // A read-only canvas keeps its edges inert end to end: no button role,
  // no focusability, no hit area — so pointer and keyboard agree.
  const isInteractive =
    !readOnly &&
    (interactive ?? (onClick !== undefined || onDelete !== undefined))

  return (
    <g
      role={isInteractive ? "button" : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      // Selection is visible state, so assistive technology hears it too.
      aria-pressed={
        isInteractive && selected !== undefined ? selected : undefined
      }
      {...props}
      data-slot="workflow-canvas-edge"
      data-source={source}
      data-target={target}
      data-selected={selected ? "true" : undefined}
      className={cn(
        // An outline on an SVG group draws a rectangle around the curve's
        // whole bounding box, so focus is presented on the line itself
        // below instead.
        "group/workflow-edge outline-none",
        isInteractive && "cursor-pointer",
      )}
      onClick={onClick}
      onKeyDown={(event) => {
        onKeyDown?.(event)

        // Keys pressed inside a focusable child (a label editor, a badge
        // button) belong to that child, never to the edge.
        if (
          event.defaultPrevented ||
          !isInteractive ||
          event.target !== event.currentTarget
        ) {
          return
        }

        // A focusable edge activates like a button: Enter and Space click it.
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          event.currentTarget.dispatchEvent(
            new MouseEvent("click", { bubbles: true }),
          )
          return
        }

        // A read-only canvas keeps its structure; deletion stays inert.
        if (
          (event.key === "Delete" || event.key === "Backspace") &&
          onDelete &&
          !readOnly
        ) {
          event.preventDefault()
          event.stopPropagation()

          // The consumer decides whether anything is deleted — it may
          // refuse, or confirm first — so focus is only rescued if the
          // edge actually left the document.
          const activeBefore = event.currentTarget

          onDelete()
          queueMicrotask(() => {
            if (!activeBefore.isConnected) {
              getRootElement()?.focus()
            }
          })
        }
      }}
    >
      {isInteractive ? (
        <path
          data-slot="workflow-canvas-edge-hit"
          d={geometry.path}
          fill="none"
          // The grab band widens inversely to zoom so it stays ~16 screen
          // pixels: scaled with the surface it would shrink to a few
          // pixels on a zoomed-out canvas, exactly where edges are hardest
          // to hit. `vector-effect` cannot do this — the zoom is a CSS
          // transform on an HTML ancestor, outside the SVG's own
          // coordinate chain — so the surface publishes its zoom and the
          // band divides by it. The fallback keeps a sane band for an edge
          // layer mounted outside a surface.
          className="stroke-transparent [pointer-events:stroke] [stroke-width:calc(16/var(--nessa-workflow-canvas-zoom,1))]"
        />
      ) : null}
      <path
        data-slot="workflow-canvas-edge-line"
        d={geometry.path}
        fill="none"
        strokeLinecap="round"
        className={cn(
          "stroke-border stroke-[2.5]",
          "transition-colors [transition-duration:var(--nessa-motion-duration-fast)] [transition-timing-function:var(--nessa-motion-easing-standard)] motion-reduce:transition-none",
          "group-hover/workflow-edge:stroke-ring group-data-[selected=true]/workflow-edge:stroke-ring",
          "group-focus-visible/workflow-edge:stroke-[3.5] group-focus-visible/workflow-edge:stroke-ring",
          className,
        )}
      />
      {children}
    </g>
  )
}

/** Properties accepted by the live connection line. */
interface WorkflowCanvasConnectionLineProps
  extends React.ComponentProps<"path"> {}

/**
 * The live line drawn while a connection gesture is in flight, from the
 * source handle's anchor to wherever the pointer or keyboard has taken the
 * free end. Rendered automatically by `WorkflowCanvasEdges`; pass a styled
 * one through its `connectionLine` property to restyle it.
 *
 * @param props - Native path properties.
 * @returns The dashed connection path, or nothing while no connection is
 * being drawn.
 */
function WorkflowCanvasConnectionLine({
  className,
  ...props
}: WorkflowCanvasConnectionLineProps) {
  const pending = useWorkflowCanvasPendingConnection()
  // Subscribed, not just read: the source node can move or resize while a
  // connection is being drawn, and the line's anchor must follow it.
  const sourceGeometry = useWorkflowCanvasNodeGeometry(pending?.source ?? "")

  // A keyboard-armed connection has no free end travelling anywhere — the
  // pressed handle and the canvas' connecting state carry the feedback, and
  // no line is drawn that could linger while nodes move.
  if (!pending || pending.mode !== "pointer") {
    return null
  }

  if (!sourceGeometry) {
    return null
  }

  const sourceAnchor = nodeAnchorPoint(sourceGeometry, pending.sourceSide)
  // The free end curves back toward wherever the gesture came from, so
  // approaching a node from any direction reads as a clean arc instead of
  // an S-shaped wave.
  const freeSide = nearestNodeSide(
    { x: pending.point.x, y: pending.point.y, width: 0, height: 0 },
    sourceAnchor,
  )

  return (
    <path
      {...props}
      data-slot="workflow-canvas-connection-line"
      fill="none"
      d={edgePath(sourceAnchor, pending.sourceSide, pending.point, freeSide)}
      className={cn(
        "stroke-ring stroke-[2.5] [stroke-dasharray:6_4]",
        className,
      )}
    />
  )
}

export {
  WorkflowCanvasConnectionLine,
  WorkflowCanvasEdge,
  WorkflowCanvasEdges,
  useWorkflowCanvasEdgeGeometry,
  type WorkflowCanvasConnectionLineProps,
  type WorkflowCanvasEdgeGeometry,
  type WorkflowCanvasEdgeOptions,
  type WorkflowCanvasEdgeProps,
  type WorkflowCanvasEdgesProps,
}
