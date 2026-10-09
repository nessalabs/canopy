/**
 * Left-to-right layered layout for a change map.
 *
 * - Columns: every node sits one column past its furthest predecessor.
 * - Waypoints: an edge that skips columns gets a waypoint in each column it crosses. Waypoints
 *   are ordered and stacked with the cards, so the edge passes between cards, never through one.
 * - Ordering: three barycenter sweeps order each column to untangle crossings.
 * - Gaps: each gap is as wide as the widest label placed in it.
 * - Labels: the ones that share a gap are pushed apart.
 * - Back edges: an edge that runs backwards, or stays in its column, is routed through the gaps
 *   to a lane of its own under the whole map.
 */

export interface ChangeMapLayoutInput {
  nodes: readonly { id: string; width: number }[]
  /** `labelWidth` is how wide the edge's label draws; absent for an edge without one. */
  edges: readonly { from: string; to: string; labelWidth?: number }[]
  nodeHeight: number
  /** The narrowest a gap between columns gets, with or without labels. */
  columnGap: number
  rowGap: number
  labelHeight: number
}

export interface ChangeMapPoint {
  x: number
  y: number
}

export interface ChangeMapBox extends ChangeMapPoint {
  width: number
  height: number
}

export interface ChangeMapLayoutEdge {
  /** The edge's index in the input. */
  index: number
  path: string
  label: ChangeMapPoint
  /** Routed under the map: the edge runs backwards or within one column. */
  back: boolean
}

export interface ChangeMapLayout {
  boxes: ReadonlyMap<string, ChangeMapBox>
  edges: ChangeMapLayoutEdge[]
  width: number
  height: number
}

/** A card, or a waypoint holding a long edge's place in a column it crosses. */
interface Item {
  id: string
  column: number
  height: number
  y: number
}

type Edge = { from: string; to: string; labelWidth?: number; index: number }

const WAYPOINT_HEIGHT = 12
const LANE_STEP = 8
const LABEL_PAD = 24
const CORNER = 6

const average = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length
const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0)

/** Kahn's order; nodes stuck in a cycle follow in input order, so every node gets a column. */
function topologicalOrder(ids: readonly string[], edges: readonly Edge[]): string[] {
  const incoming = new Map(ids.map((id) => [id, 0]))
  for (const edge of edges) incoming.set(edge.to, incoming.get(edge.to)! + 1)
  const queue = ids.filter((id) => incoming.get(id) === 0)
  const order: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    order.push(id)
    for (const edge of edges) {
      if (edge.from !== id) continue
      incoming.set(edge.to, incoming.get(edge.to)! - 1)
      if (incoming.get(edge.to) === 0) queue.push(edge.to)
    }
  }
  return [...order, ...ids.filter((id) => !order.includes(id))]
}

/** Column per node: one past the furthest predecessor met earlier in the order. */
function columnsFor(order: readonly string[], edges: readonly Edge[]): Map<string, number> {
  const rank = new Map(order.map((id, index) => [id, index]))
  const column = new Map<string, number>()
  for (const id of order) {
    const before = edges.filter((edge) => edge.to === id && rank.get(edge.from)! < rank.get(id)!)
    column.set(id, before.reduce((deepest, edge) => Math.max(deepest, column.get(edge.from)! + 1), 0))
  }
  return column
}

function stack(items: Item[], rowGap: number): void {
  let y = 0
  for (const item of items) {
    item.y = y
    y += item.height + rowGap
  }
}

const centre = (item: Item): number => item.y + item.height / 2

/** Reorders each column by the mean height of its neighbours in the column swept from. */
function sweep(columns: Item[][], neighbours: (id: string) => string[], byId: ReadonlyMap<string, Item>, rowGap: number): void {
  for (const items of columns) {
    const keyed = items.map((item) => {
      const around = neighbours(item.id).map((id) => centre(byId.get(id)!))
      return { item, key: around.length > 0 ? average(around) : centre(item) }
    })
    keyed.sort((a, b) => a.key - b.key)
    items.splice(0, items.length, ...keyed.map(({ item }) => item))
    stack(items, rowGap)
  }
}

/** A cubic from `a` to `b` that leaves and arrives level: an edge crossing a gap. */
const across = (a: ChangeMapPoint, b: ChangeMapPoint): string => {
  const bend = (b.x - a.x) / 2
  return `C ${a.x + bend} ${a.y}, ${b.x - bend} ${b.y}, ${b.x} ${b.y}`
}

/** An orthogonal polyline with its corners rounded: a route under the map, or between grid cells. */
export function rounded(points: readonly ChangeMapPoint[]): string {
  let path = `M ${points[0]!.x} ${points[0]!.y}`
  for (let i = 1; i < points.length - 1; i++) {
    const [prev, at, next] = [points[i - 1]!, points[i]!, points[i + 1]!]
    const into = Math.min(CORNER, Math.hypot(at.x - prev.x, at.y - prev.y) / 2)
    const out = Math.min(CORNER, Math.hypot(next.x - at.x, next.y - at.y) / 2)
    const from = { x: at.x - Math.sign(at.x - prev.x) * into, y: at.y - Math.sign(at.y - prev.y) * into }
    const to = { x: at.x + Math.sign(next.x - at.x) * out, y: at.y + Math.sign(next.y - at.y) * out }
    path += ` L ${from.x} ${from.y} Q ${at.x} ${at.y}, ${to.x} ${to.y}`
  }
  const last = points.at(-1)!
  return `${path} L ${last.x} ${last.y}`
}

/** Where on a card's side each of several edges attaches: spread about the middle, in order. */
function ports(box: ChangeMapBox, count: number): number[] {
  const step = Math.min(12, (box.height * 0.6) / Math.max(1, count - 1))
  return Array.from({ length: count }, (_, i) => box.y + box.height / 2 + (i - (count - 1) / 2) * step)
}

export function layoutChangeMap({ nodes, edges, nodeHeight, columnGap, rowGap, labelHeight }: ChangeMapLayoutInput): ChangeMapLayout {
  const ids = nodes.map((node) => node.id)
  const widthOf = new Map(nodes.map((node) => [node.id, node.width]))
  const usable = edges.map((edge, index) => ({ ...edge, index })).filter((edge) => widthOf.has(edge.from) && widthOf.has(edge.to) && edge.from !== edge.to)
  const order = topologicalOrder(ids, usable)
  const column = columnsFor(order, usable)
  const forward = usable.filter((edge) => column.get(edge.to)! > column.get(edge.from)!)
  const back = usable.filter((edge) => column.get(edge.to)! <= column.get(edge.from)!)

  // Cards and waypoints per column; a forward edge is the chain of items it passes through.
  const columns: Item[][] = []
  const add = (item: Item): void => void (columns[item.column] ??= []).push(item)
  for (const id of order) add({ id, column: column.get(id)!, height: nodeHeight, y: 0 })
  const chains = new Map<number, string[]>()
  for (const edge of forward) {
    const chain = [edge.from]
    for (let c = column.get(edge.from)! + 1; c < column.get(edge.to)!; c++) {
      const id = `\u0000${edge.index}:${c}`
      add({ id, column: c, height: WAYPOINT_HEIGHT, y: 0 })
      chain.push(id)
    }
    chains.set(edge.index, [...chain, edge.to])
  }
  const links = [...chains.values()].flatMap((chain) => chain.slice(1).map((to, i) => ({ from: chain[i]!, to })))
  const byId = new Map(columns.flat().map((item) => [item.id, item]))
  const preds = (id: string): string[] => links.filter((link) => link.to === id).map((link) => link.from)
  const succs = (id: string): string[] => links.filter((link) => link.from === id).map((link) => link.to)
  columns.forEach((items) => stack(items, rowGap))
  sweep(columns.slice(1), preds, byId, rowGap)
  sweep([...columns].reverse().slice(1), succs, byId, rowGap)
  sweep(columns.slice(1), preds, byId, rowGap)

  // Centre every column on the tallest.
  const heightOf = (items: Item[]): number => sum(items.map((item) => item.height)) + (items.length - 1) * rowGap
  const content = Math.max(...columns.map(heightOf))
  for (const items of columns) for (const item of items) item.y += (content - heightOf(items)) / 2

  // Columns as wide as their widest card; gaps as wide as their widest label; room for lanes at both ends.
  const columnWidth = columns.map((items) => Math.max(0, ...items.map((item) => widthOf.get(item.id) ?? 0)))
  const gap = columns.slice(1).map((_, c) => Math.max(columnGap, ...forward.filter((edge) => column.get(edge.from) === c).map((edge) => (edge.labelWidth ?? 0) + LABEL_PAD)))
  const margin = back.length > 0 ? LANE_STEP * (back.length + 1) : 0
  const left: number[] = []
  columnWidth.reduce((x, width, c) => ((left[c] = x), x + width + (gap[c] ?? 0)), margin)

  const boxes = new Map<string, ChangeMapBox>()
  for (const id of ids) {
    const item = byId.get(id)!
    const width = widthOf.get(id)!
    boxes.set(id, { x: left[item.column]! + (columnWidth[item.column]! - width) / 2, y: item.y, width, height: nodeHeight })
  }

  // One lane per back edge under the map; ports ordered by where each edge goes next.
  const backLane = new Map(back.map((edge, lane) => [edge.index, lane]))
  const laneY = (lane: number): number => content + rowGap / 2 + labelHeight / 2 + lane * (labelHeight + 6)
  const nextY = (edge: Edge, end: 'from' | 'to'): number => {
    const lane = backLane.get(edge.index)
    if (lane !== undefined) return laneY(lane)
    const chain = chains.get(edge.index)!
    return centre(byId.get(end === 'from' ? chain[1]! : chain.at(-2)!)!)
  }
  const portOf = new Map<string, number>()
  for (const id of ids) {
    const outgoing = usable.filter((edge) => edge.from === id).sort((a, b) => nextY(a, 'from') - nextY(b, 'from'))
    const incoming = usable.filter((edge) => edge.to === id).sort((a, b) => nextY(a, 'to') - nextY(b, 'to'))
    ports(boxes.get(id)!, outgoing.length).forEach((y, i) => portOf.set(`${outgoing[i]!.index}:out`, y))
    ports(boxes.get(id)!, incoming.length).forEach((y, i) => portOf.set(`${incoming[i]!.index}:in`, y))
  }

  const routed = new Map<number, ChangeMapLayoutEdge>()
  for (const edge of forward) {
    const from = boxes.get(edge.from)!
    const to = boxes.get(edge.to)!
    // Out of the source, level through every waypoint's column, into the target.
    const points: ChangeMapPoint[] = [{ x: from.x + from.width, y: portOf.get(`${edge.index}:out`)! }]
    for (const id of chains.get(edge.index)!.slice(1, -1)) {
      const item = byId.get(id)!
      points.push({ x: left[item.column]!, y: centre(item) }, { x: left[item.column]! + columnWidth[item.column]!, y: centre(item) })
    }
    points.push({ x: to.x, y: portOf.get(`${edge.index}:in`)! })
    let path = `M ${points[0]!.x} ${points[0]!.y}`
    for (let i = 1; i < points.length; i++) path += i % 2 === 1 ? ` ${across(points[i - 1]!, points[i]!)}` : ` L ${points[i]!.x} ${points[i]!.y}`
    const [a, b] = [points[0]!, points[1]!]
    routed.set(edge.index, { index: edge.index, path, back: false, label: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } })
  }

  for (const edge of back) {
    const lane = backLane.get(edge.index)!
    const from = boxes.get(edge.from)!
    const to = boxes.get(edge.to)!
    const out = left[column.get(edge.from)!]! + columnWidth[column.get(edge.from)!]! + LANE_STEP * (lane + 1)
    const into = left[column.get(edge.to)!]! - LANE_STEP * (lane + 1)
    const [start, end, y] = [portOf.get(`${edge.index}:out`)!, portOf.get(`${edge.index}:in`)!, laneY(lane)]
    const path = rounded([
      { x: from.x + from.width, y: start },
      { x: out, y: start },
      { x: out, y },
      { x: into, y },
      { x: into, y: end },
      { x: to.x, y: end }
    ])
    routed.set(edge.index, { index: edge.index, path, back: true, label: { x: (out + into) / 2, y } })
  }

  // Labels sharing a gap are pushed apart, top to bottom, so none sits on another.
  const byGap = new Map<number, ChangeMapLayoutEdge[]>()
  for (const edge of forward) {
    if (!edge.labelWidth) continue
    const c = column.get(edge.from)!
    byGap.set(c, [...(byGap.get(c) ?? []), routed.get(edge.index)!])
  }
  for (const labelled of byGap.values()) {
    labelled.sort((a, b) => a.label.y - b.label.y)
    labelled.forEach((edge, i) => {
      if (i > 0) edge.label.y = Math.max(edge.label.y, labelled[i - 1]!.label.y + labelHeight + 2)
    })
  }

  return {
    boxes,
    edges: [...routed.values()].sort((a, b) => a.index - b.index),
    width: margin * 2 + sum(columnWidth) + sum(gap),
    height: back.length > 0 ? laneY(back.length - 1) + labelHeight / 2 : content
  }
}
