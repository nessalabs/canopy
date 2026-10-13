import { rounded, type ChangeMapBox, type ChangeMapLayout, type ChangeMapLayoutEdge, type ChangeMapPoint } from "../change-map/change-map-layout"

/**
 * @responsibility Pure top-to-bottom layered layout for node-and-arrow diagrams that read down a
 * narrow column — state machines, activity diagrams. No React, no DOM.
 *
 * - Back edges: a depth-first walk from the roots marks every edge that closes a cycle (self
 *   loops included). The rest form a DAG.
 * - Layers: every node sits one layer below its furthest predecessor along the DAG, so a layer is
 *   its longest path from a root.
 * - Waypoints: a forward edge that skips layers holds a slot in each layer it crosses, so it
 *   passes between nodes, never through one.
 * - Ordering: three barycenter sweeps order each layer to untangle crossings, then nodes with a
 *   back edge move to the right end; layers are centred.
 * - Gaps: a gap with a labelled edge in it grows by a label's height.
 * - Back edges run up a lane of their own to the right of everything, innermost the shortest,
 *   labelled right of the outermost lane. A node with another node to its right in its layer
 *   reaches the lanes through the gap below its layer.
 * - Labels that share a gap, or the lanes, are pushed apart.
 */

export interface TopDownLayoutInput {
  nodes: readonly { id: string; width: number; height: number }[]
  /** `labelWidth` is how wide the edge's label draws; absent for an edge without one. */
  edges: readonly { from: string; to: string; labelWidth?: number }[]
  /** Where reading starts — an initial state, a start node. Absent or empty, the nodes nothing enters. */
  roots?: readonly string[]
  /** The narrowest a gap between layers gets; a gap carrying labels adds `labelHeight`. */
  rowGap: number
  /** The gap between neighbours in one layer. */
  columnGap: number
  labelHeight: number
}

type Edge = { from: string; to: string; labelWidth?: number; index: number }

/** A node, or a waypoint holding a long edge's place in a layer it crosses. */
interface Item {
  id: string
  layer: number
  width: number
  x: number
}

const WAYPOINT_WIDTH = 12
const LANE_STEP = 14
const LABEL_SPACE = 6

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0)
const average = (values: readonly number[]): number => sum(values) / values.length
const centre = (item: { x: number; width: number }): number => item.x + item.width / 2

/** Depth-first from the roots, then any node left unvisited: the edges that close a cycle, and a topological order of the rest. */
function walk(ids: readonly string[], edges: readonly Edge[], roots: readonly string[]): { order: string[]; back: Set<number> } {
  const state = new Map<string, "open" | "done">()
  const finished: string[] = []
  const back = new Set<number>()
  const visit = (id: string): void => {
    state.set(id, "open")
    for (const edge of edges.filter((candidate) => candidate.from === id)) {
      if (state.get(edge.to) === "open") back.add(edge.index)
      else if (!state.has(edge.to)) visit(edge.to)
    }
    state.set(id, "done")
    finished.push(id)
  }
  for (const id of [...roots, ...ids]) if (!state.has(id)) visit(id)
  return { order: finished.reverse(), back }
}

/** Layer per node: one past its furthest predecessor, met earlier in topological order. */
function layersFor(order: readonly string[], forward: readonly Edge[]): Map<string, number> {
  const layer = new Map<string, number>()
  for (const id of order) layer.set(id, Math.max(0, ...forward.filter((edge) => edge.to === id).map((edge) => layer.get(edge.from)! + 1)))
  return layer
}

/** Lays a layer's items left to right, centred in `across`. */
function stack(items: Item[], columnGap: number, across: number): void {
  let x = (across - (sum(items.map((item) => item.width)) + (items.length - 1) * columnGap)) / 2
  for (const item of items) {
    item.x = x
    x += item.width + columnGap
  }
}

/** Reorders each layer by the mean centre of its neighbours in the layer swept from. */
function sweep(layers: Item[][], neighbours: (id: string) => string[], byId: ReadonlyMap<string, Item>, place: (items: Item[]) => void): void {
  for (const items of layers) {
    const keyed = items.map((item) => {
      const around = neighbours(item.id).map((id) => centre(byId.get(id)!))
      return { item, key: around.length > 0 ? average(around) : centre(item) }
    })
    keyed.sort((a, b) => a.key - b.key)
    items.splice(0, items.length, ...keyed.map(({ item }) => item))
    place(items)
  }
}

/** `count` positions spread about `middle`, at most `step` apart and within `span`. */
const spread = (middle: number, span: number, count: number, step: number): number[] => {
  const gap = Math.min(step, (span * 0.6) / Math.max(1, count - 1))
  return Array.from({ length: count }, (_, i) => middle + (i - (count - 1) / 2) * gap)
}

/** A cubic from `a` down to `b` that leaves and arrives vertically: an edge crossing a gap. */
const down = (a: ChangeMapPoint, b: ChangeMapPoint): string => {
  const bend = (b.y - a.y) / 2
  return `C ${a.x} ${a.y + bend}, ${b.x} ${b.y - bend}, ${b.x} ${b.y}`
}

/** Pushes labels apart along one axis, in order, so none overlaps the one before. */
function separate(labels: readonly { at: ChangeMapPoint; size: number }[], axis: "x" | "y"): void {
  const sorted = [...labels].sort((a, b) => a.at[axis] - b.at[axis])
  sorted.forEach((label, i) => {
    const before = sorted[i - 1]
    if (before) label.at[axis] = Math.max(label.at[axis], before.at[axis] + (before.size + label.size) / 2 + LABEL_SPACE)
  })
}

/** Lays a graph out top to bottom; edges to unknown nodes are dropped. Boxes and routes share one origin. */
export function layoutTopDown({ nodes, edges, roots, rowGap, columnGap, labelHeight }: TopDownLayoutInput): ChangeMapLayout {
  const ids = nodes.map((node) => node.id)
  const sizeOf = new Map(nodes.map((node) => [node.id, node]))
  const usable: Edge[] = edges.map((edge, index) => ({ ...edge, index })).filter((edge) => sizeOf.has(edge.from) && sizeOf.has(edge.to))
  const known = roots?.filter((id) => sizeOf.has(id)) ?? []
  const { order, back: backSet } = walk(ids, usable, known.length > 0 ? known : ids.filter((id) => !usable.some((edge) => edge.to === id && edge.from !== id)))
  const forward = usable.filter((edge) => !backSet.has(edge.index))
  const layer = layersFor(order, forward)

  // Nodes and waypoints per layer; a forward edge is the chain of items it passes through.
  const layers: Item[][] = []
  const add = (item: Item): void => void (layers[item.layer] ??= []).push(item)
  for (const id of order) add({ id, layer: layer.get(id)!, width: sizeOf.get(id)!.width, x: 0 })
  const chains = new Map<number, string[]>()
  for (const edge of forward) {
    const chain = [edge.from]
    for (let l = layer.get(edge.from)! + 1; l < layer.get(edge.to)!; l++) {
      const id = `\u0000${edge.index}:${l}`
      add({ id, layer: l, width: WAYPOINT_WIDTH, x: 0 })
      chain.push(id)
    }
    chains.set(edge.index, [...chain, edge.to])
  }
  const links = [...chains.values()].flatMap((chain) => chain.slice(1).map((to, i) => ({ from: chain[i]!, to })))
  const byId = new Map(layers.flat().map((item) => [item.id, item]))
  const preds = (id: string): string[] => links.filter((link) => link.to === id).map((link) => link.from)
  const succs = (id: string): string[] => links.filter((link) => link.from === id).map((link) => link.to)
  const across = Math.max(0, ...layers.map((items) => sum(items.map((item) => item.width)) + (items.length - 1) * columnGap))
  const place = (items: Item[]): void => stack(items, columnGap, across)
  layers.forEach(place)
  sweep(layers.slice(1), preds, byId, place)
  sweep([...layers].reverse().slice(1), succs, byId, place)
  sweep(layers.slice(1), preds, byId, place)
  // A node with a back edge goes rightmost in its layer, so its run out to the lanes crosses no node.
  const toLanes = new Set(usable.filter((edge) => backSet.has(edge.index)).flatMap((edge) => [edge.from, edge.to]))
  for (const items of layers) place(items.sort((a, b) => Number(toLanes.has(a.id)) - Number(toLanes.has(b.id))))

  // Layers as tall as their tallest node; a gap grows by a label's height when a labelled edge leaves into it.
  const layerHeight = layers.map((items) => Math.max(0, ...items.map((item) => sizeOf.get(item.id)?.height ?? 0)))
  const gap = layers.slice(1).map((_, l) => rowGap + (forward.some((edge) => edge.labelWidth && layer.get(edge.from) === l) ? labelHeight : 0))
  const top: number[] = []
  layerHeight.reduce((y, height, l) => ((top[l] = y), y + height + (gap[l] ?? 0)), 0)
  const content = sum(layerHeight) + sum(gap)

  const boxes = new Map<string, ChangeMapBox>()
  for (const node of nodes) {
    const item = byId.get(node.id)!
    boxes.set(node.id, { x: item.x, y: top[item.layer]! + (layerHeight[item.layer]! - node.height) / 2, width: node.width, height: node.height })
  }

  // Ports: forward edges spread along a node's bottom and top, ordered by where each goes next.
  const portOf = new Map<string, number>()
  const nextX = (edge: Edge, end: "out" | "in"): number => {
    const chain = chains.get(edge.index)!
    return centre(byId.get(end === "out" ? chain[1]! : chain.at(-2)!)!)
  }
  for (const id of ids) {
    const box = boxes.get(id)!
    for (const end of ["out", "in"] as const) {
      const ends = forward.filter((edge) => (end === "out" ? edge.from : edge.to) === id).sort((a, b) => nextX(a, end) - nextX(b, end))
      spread(centre(box), box.width, ends.length, 16).forEach((x, i) => portOf.set(`${ends[i]!.index}:${end}`, x))
    }
  }

  const routed = new Map<number, ChangeMapLayoutEdge>()
  for (const edge of forward) {
    const from = boxes.get(edge.from)!
    const to = boxes.get(edge.to)!
    // Out of the source's foot, straight down through every waypoint's layer, into the target's head.
    const points: ChangeMapPoint[] = [{ x: portOf.get(`${edge.index}:out`)!, y: from.y + from.height }]
    for (const id of chains.get(edge.index)!.slice(1, -1)) {
      const item = byId.get(id)!
      points.push({ x: centre(item), y: top[item.layer]! }, { x: centre(item), y: top[item.layer]! + layerHeight[item.layer]! })
    }
    points.push({ x: portOf.get(`${edge.index}:in`)!, y: to.y })
    const path = points.slice(1).reduce((d, point, i) => `${d} ${i % 2 === 0 ? down(points[i]!, point) : `L ${point.x} ${point.y}`}`, `M ${points[0]!.x} ${points[0]!.y}`)
    const [a, b] = [points[0]!, points[1]!]
    routed.set(edge.index, { index: edge.index, path, back: false, label: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } })
  }

  // Back edges: one lane each right of everything, the shortest innermost; ports spread down each node's right side.
  const back = usable.filter((edge) => backSet.has(edge.index)).sort((a, b) => Math.abs(layer.get(a.from)! - layer.get(a.to)!) - Math.abs(layer.get(b.from)! - layer.get(b.to)!))
  for (const id of ids) {
    const box = boxes.get(id)!
    const ends = back.flatMap((edge) => [...(edge.from === id ? [`${edge.index}:out`] : []), ...(edge.to === id ? [`${edge.index}:in`] : [])])
    spread(box.y + box.height / 2, box.height, ends.length, 10).forEach((y, i) => portOf.set(ends[i]!, y))
  }
  // From a node's right side to its lane: level when nothing stands to its right in the layer,
  // otherwise down into the gap under the layer first, so the run crosses no node.
  let detourBottom = 0
  const leg = (id: string, y: number, x: number): ChangeMapPoint[] => {
    const box = boxes.get(id)!
    const right = box.x + box.width
    const l = layer.get(id)!
    if (!ids.some((other) => layer.get(other) === l && boxes.get(other)!.x > box.x)) return [{ x: right, y }, { x, y }]
    const below = top[l]! + layerHeight[l]! + (gap[l] ?? rowGap) / 2
    detourBottom = Math.max(detourBottom, below)
    return [{ x: right, y }, { x: right + LANE_STEP / 2, y }, { x: right + LANE_STEP / 2, y: below }, { x, y: below }]
  }
  const lanes = back.length > 0 ? across + LANE_STEP * back.length : 0
  back.forEach((edge, lane) => {
    const x = across + LANE_STEP * (lane + 1)
    const [start, end] = [portOf.get(`${edge.index}:out`)!, portOf.get(`${edge.index}:in`)!]
    const path = rounded([...leg(edge.from, start, x), ...leg(edge.to, end, x).reverse()])
    // Labels sit right of the outermost lane, so none covers another lane.
    routed.set(edge.index, { index: edge.index, path, back: true, label: { x: lanes + LABEL_SPACE + (edge.labelWidth ?? 0) / 2, y: (start + end) / 2 } })
  })

  // Labels sharing a gap are pushed apart sideways; labels on the lanes, downwards.
  const tag = (edge: Edge, size: number) => ({ at: routed.get(edge.index)!.label, size })
  for (let l = 0; l < layers.length; l++) separate(forward.filter((edge) => edge.labelWidth && layer.get(edge.from) === l).map((edge) => tag(edge, edge.labelWidth!)), "x")
  separate(back.filter((edge) => edge.labelWidth).map((edge) => tag(edge, labelHeight)), "y")

  const labelRight = Math.max(0, ...usable.map((edge) => (routed.get(edge.index)?.label.x ?? 0) + (edge.labelWidth ?? 0) / 2))
  const labelBottom = Math.max(0, ...back.filter((edge) => edge.labelWidth).map((edge) => routed.get(edge.index)!.label.y + labelHeight / 2))
  return {
    boxes,
    edges: [...routed.values()].sort((a, b) => a.index - b.index),
    width: Math.max(across, lanes, labelRight),
    height: Math.max(content, labelBottom, detourBottom),
  }
}
