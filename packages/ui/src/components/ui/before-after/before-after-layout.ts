import { rounded, type ChangeMapBox, type ChangeMapPoint } from "../change-map/change-map-layout"

export type BeforeAfterSide = "before" | "after"

export interface BeforeAfterLayoutInput {
  rows: readonly { id: string }[]
  /** Arrows within one side, between its rows; `labelWidth` is how wide the label draws. */
  flows: readonly { side: BeforeAfterSide; from: string; to: string; labelWidth?: number }[]
  cardWidth: number
  rowHeight: number
  rowGap: number
  /** The strip between the sides that marks each row's change. */
  gutter: number
  /** Room above the rows for each side's name. */
  headerHeight: number
}

export interface BeforeAfterLayout {
  /** Each row's card on each side, at the same height on both. */
  rows: ReadonlyMap<string, { before: ChangeMapBox; after: ChangeMapBox; marker: ChangeMapPoint }>
  sides: Record<BeforeAfterSide, { x: number }>
  flows: { index: number; path: string; label: ChangeMapPoint; align: "start" | "end" }[]
  width: number
  height: number
}

const LANE_STEP = 10
const LANE_START = 16
const LABEL_GAP = 6

/**
 * Before and after, side by side: every part on its own row, at the same height on both sides,
 * so what changed reads straight across. Flows within a side run in a lane outside its column
 * — left of before, right of after — so they never cross a card, each in a lane of its own.
 */
export function layoutBeforeAfter({ rows, flows, cardWidth: w, rowHeight: h, rowGap, gutter, headerHeight }: BeforeAfterLayoutInput): BeforeAfterLayout {
  const order = new Map(rows.map((row, i) => [row.id, i]))
  const valid = flows.map((flow, index) => ({ ...flow, index })).filter((flow) => order.has(flow.from) && order.has(flow.to) && flow.from !== flow.to)
  const bySide = (side: BeforeAfterSide) => valid.filter((flow) => flow.side === side)
  const room = (side: BeforeAfterSide): number => {
    const own = bySide(side)
    if (own.length === 0) return 0
    return LANE_START + own.length * LANE_STEP + LABEL_GAP + Math.max(0, ...own.map((flow) => flow.labelWidth ?? 0))
  }
  const left = room("before")
  const sides = { before: { x: left }, after: { x: left + w + gutter } }
  const top = (i: number): number => headerHeight + i * (h + rowGap)

  const placed = new Map(
    rows.map((row, i) => [
      row.id,
      {
        before: { x: sides.before.x, y: top(i), width: w, height: h },
        after: { x: sides.after.x, y: top(i), width: w, height: h },
        marker: { x: sides.before.x + w + gutter / 2, y: top(i) + h / 2 },
      },
    ]),
  )

  const routed = (["before", "after"] as const).flatMap((side) =>
    bySide(side).map((flow, k) => {
      const outward = side === "before" ? -1 : 1
      const edge = side === "before" ? sides.before.x : sides.after.x + w
      const laneX = edge + outward * (LANE_START + k * LANE_STEP)
      const [a, b] = [top(order.get(flow.from)!) + h / 2, top(order.get(flow.to)!) + h / 2]
      const points: ChangeMapPoint[] = [{ x: edge, y: a }, { x: laneX, y: a }, { x: laneX, y: b }, { x: edge, y: b }]
      const lanesOut = edge + outward * (LANE_START + bySide(side).length * LANE_STEP)
      return { index: flow.index, path: rounded(points), label: { x: lanesOut + outward * LABEL_GAP, y: (a + b) / 2 }, align: side === "before" ? ("end" as const) : ("start" as const) }
    }),
  )

  const height = rows.length === 0 ? headerHeight : top(rows.length - 1) + h
  return { rows: placed, sides, flows: routed, width: left + w * 2 + gutter + room("after"), height }
}
