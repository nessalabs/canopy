import type { ChangeMapSpec, PartStatus } from '../schemas/change-map'
import type { ActivitySpec, CallFlowSpec, DataModelSpec, StateMachineSpec } from '../schemas/diagrams'
import { refsOf } from './apply'
import type { BoardVersion, BoxNote, BoxStatus } from './board'
import { END_ID, START_ID, type Graph, type GraphNode } from './graph'

/**
 * A board as one of Canopy's own drawings. The agent writes Mermaid; the reader sees the same
 * cards, arrows and colours as every other diagram in Canopy, each box clickable. Which drawing a
 * board becomes follows from what was written: a flowchart with decisions or start/end circles is
 * a step-by-step activity, any other flowchart a map of parts.
 */

export type PlanDrawing =
  | { type: 'change-map'; spec: ChangeMapSpec }
  | { type: 'activity'; spec: ActivitySpec }
  | { type: 'call-flow'; spec: CallFlowSpec }
  | { type: 'state-machine'; spec: StateMachineSpec }
  | { type: 'data-model'; spec: DataModelSpec }

/** How each box status is coloured, in the drawings' own vocabulary. */
export const PART_STATUS: Record<BoxStatus, PartStatus> = { new: 'added', changed: 'modified', removed: 'deleted', context: 'external', risk: 'affected' }

/** Where a box's code is, from the first of its refs. */
export function located(note: Pick<BoxNote, 'ref'> | undefined): { path?: string; lines?: string } {
  const [first] = note ? refsOf(note) : []
  if (!first) return {}
  const [path, lines] = first.split(':')
  return { path, ...(lines ? { lines } : {}) }
}

const part = (node: GraphNode, notes: Record<string, BoxNote>) => ({
  id: node.id,
  label: node.label,
  status: PART_STATUS[notes[node.id]?.status ?? 'context'],
  ...located(notes[node.id])
})

const isActivity = (graph: Graph): boolean => graph.nodes.some((node) => node.shape === 'decision' || node.shape === 'circle')

function activity(graph: Graph, notes: Record<string, BoxNote>): ActivitySpec {
  // A circle the flow leaves is its start, even when a loop comes back to it; one it never leaves is an end.
  const sources = new Set(graph.edges.map((edge) => edge.from))
  const kind = (node: GraphNode): ActivitySpec['steps'][number]['kind'] => {
    if (node.shape === 'circle') return sources.has(node.id) ? 'start' : 'end'
    return node.shape === 'decision' ? 'decision' : 'action'
  }
  return { steps: graph.nodes.map((node) => ({ ...part(node, notes), kind: kind(node) })), flows: graph.edges.map(({ from, to, label }) => ({ from, to, label })) }
}

const changeMap = (graph: Graph, notes: Record<string, BoxNote>): ChangeMapSpec => ({
  nodes: graph.nodes.map((node) => part(node, notes)),
  edges: graph.edges.map(({ from, to, label }) => ({ from, to, label }))
})

const KIND_OF_STATE = { [START_ID]: 'initial', [END_ID]: 'final' } as Record<string, 'initial' | 'final'>

const stateMachine = (graph: Graph, notes: Record<string, BoxNote>): StateMachineSpec => ({
  states: graph.nodes.map((node) => ({ ...part(node, notes), kind: KIND_OF_STATE[node.id] ?? 'normal' })),
  transitions: graph.edges.map(({ from, to, label, guard }) => ({ from, to, label, guard }))
})

const MESSAGE_KIND = { call: 'call', return: 'return', async: 'async' } as const

const callFlow = (graph: Graph, notes: Record<string, BoxNote>): CallFlowSpec => ({
  participants: graph.nodes.map((node) => part(node, notes)),
  steps: graph.edges.map(({ from, to, label, style, branch }) => ({ from, to, label: label || '…', kind: MESSAGE_KIND[style as keyof typeof MESSAGE_KIND] ?? 'call', branch }))
})

const dataModel = (graph: Graph, notes: Record<string, BoxNote>): DataModelSpec => ({
  entities: graph.nodes.map((node) => ({ ...part(node, notes), fields: node.fields ?? [] })),
  relations: graph.edges.map(({ from, to, label, cardinality }) => ({ from, to, label, cardinality }))
})

const DRAW: Record<Graph['kind'], (graph: Graph, notes: Record<string, BoxNote>) => PlanDrawing> = {
  flowchart: (graph, notes) => (isActivity(graph) ? { type: 'activity', spec: activity(graph, notes) } : { type: 'change-map', spec: changeMap(graph, notes) }),
  sequence: (graph, notes) => ({ type: 'call-flow', spec: callFlow(graph, notes) }),
  state: (graph, notes) => ({ type: 'state-machine', spec: stateMachine(graph, notes) }),
  er: (graph, notes) => ({ type: 'data-model', spec: dataModel(graph, notes) }),
  class: (graph, notes) => ({ type: 'data-model', spec: dataModel(graph, notes) })
}

/** Any picture drawn with Canopy's diagrams; boxes without a note are drawn as context. */
export const graphDrawing = (graph: Graph, notes: Record<string, BoxNote> = {}): PlanDrawing => DRAW[graph.kind](graph, notes)

/** A board as drawn: the picture after the change, or (`today`) the one as things are now. */
export const boardDrawing = (version: Pick<BoardVersion, 'graph' | 'before' | 'notes'>, today = false): PlanDrawing =>
  today && version.before ? graphDrawing(version.before, asToday(version.notes)) : graphDrawing(version.graph, version.notes)

/** Today nothing has changed yet: every box is context, except those the change takes away. */
const asToday = (notes: Record<string, BoxNote>): Record<string, BoxNote> =>
  Object.fromEntries(Object.entries(notes).map(([id, note]) => [id, { ...note, status: note.status === 'removed' ? 'removed' : 'context' }]))
