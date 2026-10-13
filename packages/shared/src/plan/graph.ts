/**
 * What a plan board's Mermaid says, once read: boxes and the arrows between them, whatever kind of
 * diagram it was written as. Every kind lands in this one shape so that patching a board, checking
 * it and turning it into a drawing are each written once.
 */

export const DIAGRAM_KINDS = ['flowchart', 'sequence', 'state', 'er', 'class'] as const
export type DiagramKind = (typeof DIAGRAM_KINDS)[number]

/** How a box was drawn, which decides what it means: a decision, a start or end, a store. */
export type Shape = 'box' | 'round' | 'decision' | 'circle' | 'store' | 'initial' | 'final' | 'participant' | 'actor' | 'entity'

export interface Field {
  name: string
  type?: string
  key?: 'primary' | 'foreign'
  note?: string
}

export interface GraphNode {
  id: string
  label: string
  shape: Shape
  /** An entity's or class's members. */
  fields?: Field[]
}

export type EdgeStyle = 'solid' | 'dashed' | 'thick' | 'call' | 'return' | 'async'

export interface GraphEdge {
  from: string
  to: string
  label?: string
  style: EdgeStyle
  /** A state transition's `[guard]`. */
  guard?: string
  /** A relation's cardinality, `1:0..N`. */
  cardinality?: string
  /** The condition a sequence message runs under (`alt`, `opt`, `loop`…). */
  branch?: string
}

export interface Graph {
  kind: DiagramKind
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/** The ids a start and end pseudostate (`[*]`) are drawn under. Synthetic: they need no note. */
export const START_ID = '__start'
export const END_ID = '__end'
export const isSynthetic = (id: string): boolean => id === START_ID || id === END_ID

/** What an edit names an arrow by: `a->b`. */
export const edgeKey = (edge: Pick<GraphEdge, 'from' | 'to'>): string => `${edge.from}->${edge.to}`
