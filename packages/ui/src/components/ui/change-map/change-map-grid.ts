import { rounded, type ChangeMapLayout, type ChangeMapPoint } from "./change-map-layout"

export interface ChangeMapGridInput {
  /** `height` overrides `cardHeight` for one card; a row is as tall as its tallest card. */
  nodes: readonly { id: string; height?: number }[]
  edges: readonly { from: string; to: string }[]
  /** How many cards fit across; the grid never has more columns than cards. */
  columns: number
  cardWidth: number
  cardHeight: number
  columnGap: number
  rowGap: number
}

/** Edges sharing a gap run side by side this far apart, so each stays traceable. */
const LANE_STEP = 5
const LANES = 5

/**
 * Cards in reading order across a wrapping grid, for maps whose order matters more than their
 * flow — a review's features, foundations first. Edges never cross a card: each leaves its card's
 * bottom, runs along the gaps between rows and columns, and enters its target from above (or from
 * below, when the target sits on the same row or higher up). One that runs back up the grid is marked `back`.
 */
export function layoutChangeMapGrid({ nodes, edges, columns, cardWidth: w, cardHeight, columnGap, rowGap }: ChangeMapGridInput): ChangeMapLayout {
  const across = Math.max(1, Math.min(columns, nodes.length))
  const rows = Math.ceil(nodes.length / across)
  const heightOf = (i: number): number => nodes[i]?.height ?? cardHeight
  const rowHeight = Array.from({ length: rows }, (_, row) => Math.max(...Array.from({ length: Math.min(across, nodes.length - row * across) }, (_, c) => heightOf(row * across + c))))
  const rowTop: number[] = []
  rowHeight.reduce((top, height, row) => ((rowTop[row] = top), top + height + rowGap), 0)

  const cell = new Map(nodes.map((node, i) => [node.id, { column: i % across, row: Math.floor(i / across), height: heightOf(i) }]))
  const boxes = new Map([...cell].map(([id, { column, row, height }]) => [id, { x: column * (w + columnGap), y: rowTop[row]!, width: w, height }]))

  // The middle of the gap under a row (and above the first, for edges that climb to it), and of the gap left of a column.
  const under = (row: number): number => (row < 0 ? -rowGap / 2 : rowTop[row]! + rowHeight[row]! + rowGap / 2)
  const leftOf = (column: number): number => column * (w + columnGap) - columnGap / 2

  const routed = edges.flatMap((edge, index) => {
    const [a, b] = [cell.get(edge.from), cell.get(edge.to)]
    if (!a || !b || edge.from === edge.to) return []
    const lane = ((index % LANES) - (LANES - 1) / 2) * LANE_STEP
    const start = { x: a.column * (w + columnGap) + w / 2 + lane, y: rowTop[a.row]! + a.height }
    const endX = b.column * (w + columnGap) + w / 2 - lane
    const gapA = under(a.row) + lane
    const points: ChangeMapPoint[] = [start, { x: start.x, y: gapA }]
    if (b.row === a.row) points.push({ x: endX, y: gapA }, { x: endX, y: rowTop[b.row]! + b.height })
    else if (b.row < a.row) {
      // Back up the grid: climb the gap left of the target's column and come in from below, so
      // the edge never leaves the drawing over its top row.
      const laneX = leftOf(b.column) + lane
      const gapB = under(b.row) + lane
      points.push({ x: laneX, y: gapA }, { x: laneX, y: gapB }, { x: endX, y: gapB }, { x: endX, y: rowTop[b.row]! + b.height })
    } else {
      const gapB = under(b.row - 1) + lane
      if (b.row !== a.row + 1) {
        const laneX = leftOf(b.column) + lane
        points.push({ x: laneX, y: gapA }, { x: laneX, y: gapB })
      }
      points.push({ x: endX, y: gapB }, { x: endX, y: rowTop[b.row]! })
    }
    const path = points.filter((point, i) => i === 0 || point.x !== points[i - 1]!.x || point.y !== points[i - 1]!.y)
    // The label sits where the edge turns into its target, so labels for different targets never share a spot.
    const turn = path[path.length - 2]!
    return [{ index, path: rounded(path), label: { x: turn.x, y: turn.y }, back: b.row < a.row }]
  })

  const height = rows === 0 ? 0 : rowTop[rows - 1]! + rowHeight[rows - 1]!
  return { boxes, edges: routed, width: across * w + (across - 1) * columnGap, height }
}

/** The shape a grid aims for when its column is too narrow to set one: a little wider than tall. */
const BALANCED_ASPECT = 1.6

/**
 * How many columns a grid of `count` cards gets: as many as fit `width`, but never so few that
 * the grid turns into a tall strip — below a balanced shape it keeps its columns and scrolls
 * sideways instead, and the full-screen view shows it whole.
 */
export function gridColumns({ count, width, cardWidth, cardHeight, gap }: { count: number; width: number; cardWidth: number; cardHeight: number; gap: number }): number {
  const fit = Math.floor((width + gap) / (cardWidth + gap))
  const balanced = Math.floor(Math.sqrt((BALANCED_ASPECT * count * (cardHeight + gap)) / (cardWidth + gap)))
  return Math.max(1, Math.min(count, Math.max(fit, balanced)))
}
