"use client"

/** @responsibility Pure coordinate math for the workflow canvas: viewport transforms, zoom and pan clamping, node anchor geometry, and edge path construction. */

/** A point in either screen or canvas coordinates. */
interface WorkflowCanvasPoint {
  x: number
  y: number
}

/**
 * The visible window onto the canvas plane: `x`/`y` translate canvas content
 * in screen pixels and `zoom` scales it.
 */
interface WorkflowCanvasViewport {
  x: number
  y: number
  zoom: number
}

/** A rectangular region of the canvas plane, in canvas units. */
interface WorkflowCanvasBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** The measured placement of one node on the canvas plane, in canvas units. */
interface WorkflowCanvasNodeGeometry {
  x: number
  y: number
  width: number
  height: number
}

/** One edge of a node an edge can attach to. */
type WorkflowCanvasSide = "top" | "right" | "bottom" | "left"

/**
 * Restricts a number to a closed range.
 *
 * @param value - The number to restrict.
 * @param min - The smallest allowed value.
 * @param max - The largest allowed value.
 * @returns The value moved inside the range.
 */
function clampNumber(value: number, min: number, max: number): number {
  // Adding zero folds negative zero into plain zero so clamped results
  // compare cleanly and never print as "-0".
  return Math.min(Math.max(value, min), max) + 0
}

/**
 * Converts a screen-space point (relative to the canvas element) into a
 * point on the canvas plane.
 *
 * @param point - The screen-space point.
 * @param viewport - The viewport the canvas currently renders.
 * @returns The equivalent canvas-plane point.
 */
function screenPointToCanvasPoint(
  point: WorkflowCanvasPoint,
  viewport: WorkflowCanvasViewport,
): WorkflowCanvasPoint {
  return {
    x: (point.x - viewport.x) / viewport.zoom,
    y: (point.y - viewport.y) / viewport.zoom,
  }
}

/**
 * Converts a canvas-plane point into screen space relative to the canvas
 * element.
 *
 * @param point - The canvas-plane point.
 * @param viewport - The viewport the canvas currently renders.
 * @returns The equivalent screen-space point.
 */
function canvasPointToScreenPoint(
  point: WorkflowCanvasPoint,
  viewport: WorkflowCanvasViewport,
): WorkflowCanvasPoint {
  return {
    x: point.x * viewport.zoom + viewport.x,
    y: point.y * viewport.zoom + viewport.y,
  }
}

/**
 * Produces the viewport that applies a new zoom level while keeping the
 * canvas point under the given screen point stationary, so zooming feels
 * anchored to the cursor.
 *
 * @param viewport - The current viewport.
 * @param point - The screen-space anchor, relative to the canvas element.
 * @param zoom - The requested zoom level, clamped to the allowed range.
 * @param minZoom - The smallest allowed zoom.
 * @param maxZoom - The largest allowed zoom.
 * @returns The next viewport.
 */
function zoomViewportAtPoint(
  viewport: WorkflowCanvasViewport,
  point: WorkflowCanvasPoint,
  zoom: number,
  minZoom: number,
  maxZoom: number,
): WorkflowCanvasViewport {
  const nextZoom = clampNumber(zoom, minZoom, maxZoom)
  const anchor = screenPointToCanvasPoint(point, viewport)

  return {
    x: point.x - anchor.x * nextZoom,
    y: point.y - anchor.y * nextZoom,
    zoom: nextZoom,
  }
}

/**
 * Restricts a viewport's pan so the visible window stays inside the given
 * canvas bounds. When the bounds are narrower than the window along an axis
 * the content is centered on that axis instead.
 *
 * @param viewport - The viewport to restrict.
 * @param bounds - The canvas region that must contain the visible window, or
 * null for an unbounded canvas.
 * @param viewportSize - The canvas element's size in screen pixels.
 * @returns The restricted viewport.
 */
function clampViewportToBounds(
  viewport: WorkflowCanvasViewport,
  bounds: WorkflowCanvasBounds | null,
  viewportSize: { width: number; height: number },
): WorkflowCanvasViewport {
  if (!bounds) {
    return viewport
  }

  const minPanX = viewportSize.width - bounds.maxX * viewport.zoom
  const maxPanX = -bounds.minX * viewport.zoom
  const minPanY = viewportSize.height - bounds.maxY * viewport.zoom
  const maxPanY = -bounds.minY * viewport.zoom

  return {
    x:
      minPanX > maxPanX
        ? (minPanX + maxPanX) / 2
        : clampNumber(viewport.x, minPanX, maxPanX),
    y:
      minPanY > maxPanY
        ? (minPanY + maxPanY) / 2
        : clampNumber(viewport.y, minPanY, maxPanY),
    zoom: viewport.zoom,
  }
}

/**
 * Restricts a node position so the node's box stays inside the canvas
 * bounds. When the bounds are smaller than the node the minimum edge wins.
 *
 * @param position - The requested node position, in canvas units.
 * @param size - The node's measured size, in canvas units.
 * @param bounds - The canvas region that must contain the node, or null for
 * an unbounded canvas.
 * @returns The restricted position.
 */
function clampPositionToBounds(
  position: WorkflowCanvasPoint,
  size: { width: number; height: number },
  bounds: WorkflowCanvasBounds | null,
): WorkflowCanvasPoint {
  if (!bounds) {
    return position
  }

  return {
    x: clampNumber(
      position.x,
      bounds.minX,
      Math.max(bounds.minX, bounds.maxX - size.width),
    ),
    y: clampNumber(
      position.y,
      bounds.minY,
      Math.max(bounds.minY, bounds.maxY - size.height),
    ),
  }
}

/**
 * Computes the canvas-plane point where an edge attaches to one side of a
 * node: the midpoint of that side.
 *
 * @param geometry - The node's placement.
 * @param side - The side the edge attaches to.
 * @returns The anchor point.
 */
function nodeAnchorPoint(
  geometry: WorkflowCanvasNodeGeometry,
  side: WorkflowCanvasSide,
): WorkflowCanvasPoint {
  switch (side) {
    case "top":
      return { x: geometry.x + geometry.width / 2, y: geometry.y }
    case "bottom":
      return {
        x: geometry.x + geometry.width / 2,
        y: geometry.y + geometry.height,
      }
    case "left":
      return { x: geometry.x, y: geometry.y + geometry.height / 2 }
    case "right":
      return {
        x: geometry.x + geometry.width,
        y: geometry.y + geometry.height / 2,
      }
  }
}

/**
 * Reads the outward direction of one node side as a unit vector.
 *
 * @param side - The side to read.
 * @returns The outward normal.
 */
function sideNormal(side: WorkflowCanvasSide): WorkflowCanvasPoint {
  switch (side) {
    case "top":
      return { x: 0, y: -1 }
    case "bottom":
      return { x: 0, y: 1 }
    case "left":
      return { x: -1, y: 0 }
    case "right":
      return { x: 1, y: 0 }
  }
}

/**
 * Picks the node side whose direction best matches where a point sits
 * relative to the node's center, used to settle a connection dropped on a
 * node body rather than on a specific handle.
 *
 * @param geometry - The node's placement.
 * @param point - The canvas-plane point to classify.
 * @returns The nearest side.
 */
function nearestNodeSide(
  geometry: WorkflowCanvasNodeGeometry,
  point: WorkflowCanvasPoint,
): WorkflowCanvasSide {
  const halfWidth = geometry.width / 2 || 1
  const halfHeight = geometry.height / 2 || 1
  const offsetX = (point.x - (geometry.x + geometry.width / 2)) / halfWidth
  const offsetY = (point.y - (geometry.y + geometry.height / 2)) / halfHeight

  if (Math.abs(offsetX) >= Math.abs(offsetY)) {
    return offsetX >= 0 ? "right" : "left"
  }

  return offsetY >= 0 ? "bottom" : "top"
}

/**
 * Picks the pair of facing sides that connects two nodes most directly,
 * from their relative positions: a target to the right connects right to
 * left, a target below connects bottom to top, and so on. This is the side
 * resolution behind edge auto-alignment.
 *
 * @param source - The source node's placement.
 * @param target - The target node's placement.
 * @returns The facing source and target sides.
 */
function preferredEdgeSides(
  source: WorkflowCanvasNodeGeometry,
  target: WorkflowCanvasNodeGeometry,
): { sourceSide: WorkflowCanvasSide; targetSide: WorkflowCanvasSide } {
  const deltaX =
    target.x + target.width / 2 - (source.x + source.width / 2)
  const deltaY =
    target.y + target.height / 2 - (source.y + source.height / 2)

  // Centre distance alone would pick an axis the boxes overlap on, where
  // the facing sides point away from each other and the edge doubles back
  // across both bodies. The axis the boxes actually clear on wins; when
  // both clear (a diagonal neighbour) or neither does (overlapping boxes)
  // the dominant centre delta decides, as before.
  const gapX = Math.max(
    source.x - (target.x + target.width),
    target.x - (source.x + source.width),
  )
  const gapY = Math.max(
    source.y - (target.y + target.height),
    target.y - (source.y + source.height),
  )

  if (gapX >= 0 && gapY < 0) {
    return deltaX >= 0
      ? { sourceSide: "right", targetSide: "left" }
      : { sourceSide: "left", targetSide: "right" }
  }

  if (gapY >= 0 && gapX < 0) {
    return deltaY >= 0
      ? { sourceSide: "bottom", targetSide: "top" }
      : { sourceSide: "top", targetSide: "bottom" }
  }

  if (Math.abs(deltaX) >= Math.abs(deltaY)) {
    return deltaX >= 0
      ? { sourceSide: "right", targetSide: "left" }
      : { sourceSide: "left", targetSide: "right" }
  }

  return deltaY >= 0
    ? { sourceSide: "bottom", targetSide: "top" }
    : { sourceSide: "top", targetSide: "bottom" }
}

/**
 * Computes the two control points of an edge's cubic curve, reaching
 * outward from each side so the edge leaves and enters nodes perpendicular
 * to their borders.
 *
 * @param source - The source anchor point.
 * @param sourceSide - The side the edge leaves from.
 * @param target - The target anchor point.
 * @param targetSide - The side the edge arrives at.
 * @returns The curve's control points.
 */
function edgeControlPoints(
  source: WorkflowCanvasPoint,
  sourceSide: WorkflowCanvasSide,
  target: WorkflowCanvasPoint,
  targetSide: WorkflowCanvasSide,
): { controlA: WorkflowCanvasPoint; controlB: WorkflowCanvasPoint } {
  const distance = Math.hypot(target.x - source.x, target.y - source.y)
  const reach = clampNumber(distance / 2, 24, 160)
  const sourceNormal = sideNormal(sourceSide)
  const targetNormal = sideNormal(targetSide)

  return {
    controlA: {
      x: source.x + sourceNormal.x * reach,
      y: source.y + sourceNormal.y * reach,
    },
    controlB: {
      x: target.x + targetNormal.x * reach,
      y: target.y + targetNormal.y * reach,
    },
  }
}

/**
 * Builds the SVG path for an edge between two anchor points: a cubic curve
 * whose control points reach outward from each side, so the edge leaves and
 * enters nodes perpendicular to their borders.
 *
 * @param source - The source anchor point.
 * @param sourceSide - The side the edge leaves from.
 * @param target - The target anchor point.
 * @param targetSide - The side the edge arrives at.
 * @returns An SVG path definition.
 */
function edgePath(
  source: WorkflowCanvasPoint,
  sourceSide: WorkflowCanvasSide,
  target: WorkflowCanvasPoint,
  targetSide: WorkflowCanvasSide,
): string {
  const { controlA, controlB } = edgeControlPoints(
    source,
    sourceSide,
    target,
    targetSide,
  )

  return `M ${source.x},${source.y} C ${controlA.x},${controlA.y} ${controlB.x},${controlB.y} ${target.x},${target.y}`
}

/**
 * Computes the point halfway along an edge's curve, where labels and other
 * decorations sit naturally.
 *
 * @param source - The source anchor point.
 * @param sourceSide - The side the edge leaves from.
 * @param target - The target anchor point.
 * @param targetSide - The side the edge arrives at.
 * @returns The curve's midpoint.
 */
function edgeMidpoint(
  source: WorkflowCanvasPoint,
  sourceSide: WorkflowCanvasSide,
  target: WorkflowCanvasPoint,
  targetSide: WorkflowCanvasSide,
): WorkflowCanvasPoint {
  const { controlA, controlB } = edgeControlPoints(
    source,
    sourceSide,
    target,
    targetSide,
  )

  // A cubic Bézier evaluated at t = 0.5 folds to this weighted average.
  return {
    x: (source.x + 3 * controlA.x + 3 * controlB.x + target.x) / 8,
    y: (source.y + 3 * controlA.y + 3 * controlB.y + target.y) / 8,
  }
}

export {
  canvasPointToScreenPoint,
  clampNumber,
  clampPositionToBounds,
  clampViewportToBounds,
  edgeControlPoints,
  edgeMidpoint,
  edgePath,
  nearestNodeSide,
  nodeAnchorPoint,
  preferredEdgeSides,
  screenPointToCanvasPoint,
  sideNormal,
  zoomViewportAtPoint,
  type WorkflowCanvasBounds,
  type WorkflowCanvasNodeGeometry,
  type WorkflowCanvasPoint,
  type WorkflowCanvasSide,
  type WorkflowCanvasViewport,
}
