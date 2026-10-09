import { rounded, type ChangeMapBox, type ChangeMapPoint } from "../change-map/change-map-layout"

export type BlastRadiusColumn = "upstream" | "changed" | "downstream"

export interface BlastRadiusLayoutInput {
  upstream: readonly string[]
  changed: readonly string[]
  downstream: readonly string[]
  tests: readonly string[]
  /** Calls between parts, in either direction. */
  links: readonly { from: string; to: string }[]
  /** Which changed part each test exercises. */
  covers: readonly { test: string; target: string }[]
  cardWidth: number
  cardHeight: number
  columnGap: number
  rowGap: number
  /** Past this many cards a column wraps into side-by-side sub-columns. */
  maxRows: number
  /** Room above each column (and the tests) for its name. */
  headerHeight: number
}

export interface BlastRadiusLayout {
  boxes: ReadonlyMap<string, ChangeMapBox>
  /** Where each column's name goes, and the area the changed column is shaded over. */
  columns: { key: BlastRadiusColumn; x: number; width: number }[]
  /** Where the parts end and the gap above the tests begins. */
  gridBottom: number
  testsTop: number
  edges: { index: number; kind: "link" | "covers"; path: string }[]
  width: number
  height: number
}

const LANE_STEP = 4
const LANES = 7
/** The gap between the parts and the tests underneath. */
const BAND_GAP = 56

const laneOf = (index: number): number => ((index % LANES) - (LANES - 1) / 2) * LANE_STEP

/**
 * A change's reach: what calls it on the left, the changed parts in the middle, what they call on
 * the right, and the tests that cover them underneath. A tall column wraps into sub-columns, and
 * every column shares one row grid, so edges run along the gaps between rows and columns and
 * never through a card.
 */
export function layoutBlastRadius(input: BlastRadiusLayoutInput): BlastRadiusLayout {
  const { cardWidth: w, cardHeight: h, columnGap, rowGap, maxRows, headerHeight } = input
  const groups = (["upstream", "changed", "downstream"] as const).map((key) => {
    const ids = input[key]
    const across = Math.max(1, Math.ceil(ids.length / maxRows))
    return { key, ids, across, rows: Math.ceil(ids.length / across) }
  }).filter((group) => group.ids.length > 0)
  const tallest = Math.max(1, ...groups.map((group) => group.rows))
  const pitch = h + rowGap
  const top = (row: number): number => headerHeight + row * pitch

  // Every sub-column of every group gets its own slot along one row of slots.
  const cell = new Map<string, { slot: number; row: number }>()
  const columns: BlastRadiusLayout["columns"] = []
  let slot = 0
  for (const group of groups) {
    // A short column is centred on the tallest, on whole rows so the row gaps stay shared.
    const offset = Math.floor((tallest - group.rows) / 2)
    group.ids.forEach((id, i) => cell.set(id, { slot: slot + Math.floor(i / group.rows), row: offset + (i % group.rows) }))
    columns.push({ key: group.key, x: slot * (w + columnGap), width: group.across * w + (group.across - 1) * columnGap })
    slot += group.across
  }
  const slotX = (s: number): number => s * (w + columnGap)
  const boxes = new Map<string, ChangeMapBox>([...cell].map(([id, { slot: s, row }]) => [id, { x: slotX(s), y: top(row), width: w, height: h }]))

  const gridBottom = top(tallest) - rowGap
  const testsTop = gridBottom + BAND_GAP + headerHeight
  input.tests.forEach((id, i) => boxes.set(id, { x: slotX(i), y: testsTop, width: w, height: h }))

  const edges: BlastRadiusLayout["edges"] = []
  input.links.forEach(({ from, to }, index) => {
    const [a, b] = [cell.get(from), cell.get(to)]
    if (!a || !b || from === to) return
    const lane = laneOf(index)
    const midA = top(a.row) + h / 2 + lane
    const midB = top(b.row) + h / 2 - lane
    let points: ChangeMapPoint[]
    if (a.slot === b.slot) {
      // Same sub-column: out of the right side, down the gap beside it, back in on the right.
      const gx = slotX(a.slot) + w + columnGap / 2 + lane
      points = [{ x: slotX(a.slot) + w, y: midA }, { x: gx, y: midA }, { x: gx, y: midB }, { x: slotX(b.slot) + w, y: midB }]
    } else {
      const forward = b.slot > a.slot
      const exitX = forward ? slotX(a.slot) + w : slotX(a.slot)
      const enterX = forward ? slotX(b.slot) : slotX(b.slot) + w
      const gx1 = forward ? exitX + columnGap / 2 + lane : exitX - columnGap / 2 + lane
      const gx2 = forward ? enterX - columnGap / 2 + lane : enterX + columnGap / 2 + lane
      points = [{ x: exitX, y: midA }, { x: gx1, y: midA }]
      if (Math.abs(b.slot - a.slot) > 1) {
        // Cards stand between them: cross along the gap above the target's row.
        const gy = top(b.row) - rowGap / 2 + lane
        points.push({ x: gx1, y: gy }, { x: gx2, y: gy })
      }
      points.push({ x: gx2, y: midB }, { x: enterX, y: midB })
    }
    edges.push({ index, kind: "link", path: rounded(dedupe(points)) })
  })

  input.covers.forEach(({ test, target }, index) => {
    const [t, b] = [boxes.get(test), cell.get(target)]
    if (!t || !b || !input.tests.includes(test)) return
    const lane = laneOf(index)
    const startX = t.x + w / 2 + lane
    const band = testsTop - headerHeight - BAND_GAP / 2 + lane
    const gx = slotX(b.slot) - columnGap / 2 + lane
    const under = top(b.row) + h + rowGap / 2 + lane
    const endX = slotX(b.slot) + w / 2 - lane
    const points = [{ x: startX, y: testsTop }, { x: startX, y: band }, { x: gx, y: band }, { x: gx, y: under }, { x: endX, y: under }, { x: endX, y: top(b.row) + h }]
    edges.push({ index, kind: "covers", path: rounded(dedupe(points)) })
  })

  const width = Math.max(slot, input.tests.length) * (w + columnGap) - columnGap
  return { boxes, columns, gridBottom, testsTop, edges, width: Math.max(0, width), height: input.tests.length > 0 ? testsTop + h : gridBottom }
}

const dedupe = (points: ChangeMapPoint[]): ChangeMapPoint[] => points.filter((point, i) => i === 0 || point.x !== points[i - 1]!.x || point.y !== points[i - 1]!.y)
