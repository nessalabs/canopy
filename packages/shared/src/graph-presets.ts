import { GRAPH_FENCE } from './review-graph'
import type { GraphPreset } from './schemas/review-graph'

/**
 * What a graph can be about. A preset is only words: the kinds of node and edge the agent should
 * reach for and what to look for. The graph it comes back as has the same shape whatever the
 * preset, so the cards, the layered view and the tour all work on every one of them.
 */
export interface PresetSpec {
  id: GraphPreset
  label: string
  /** One line for the picker. */
  hint: string
  /** What the agent should make the nodes of, and how to nest them. */
  focus: string
  /** Words for `kind` on a node; the first is the usual one. */
  nodeKinds: string[]
  /** Words for `kind` on an edge, each read as "from <kind> to". */
  edgeKinds: string[]
}

export const GRAPH_PRESETS: readonly PresetSpec[] = [
  {
    id: 'features',
    label: 'Features',
    hint: 'What the change does, one feature at a time',
    focus:
      'Make a node of each thing the change does, with its frontend, backend, database, tests and config together. When a feature is large, nest its sub-features inside it; a small feature has none.',
    nodeKinds: ['feature', 'sub-feature'],
    edgeKinds: ['builds-on', 'uses', 'renders']
  },
  {
    id: 'concepts',
    label: 'Concepts',
    hint: 'What the change means, from the big idea down',
    focus:
      'Make a node of each idea the change introduces, reshapes, replaces or removes — a capability, a policy, a data shape — in the words of the thing being built, not file names. Nest finer concepts inside the one they refine, so each level tells the whole story more precisely.',
    nodeKinds: ['concept', 'capability', 'policy', 'data shape'],
    edgeKinds: ['leans-on', 'replaces', 'implements']
  },
  {
    id: 'tasks',
    label: 'Tasks',
    hint: 'The work as steps someone would have done',
    focus:
      'Make a node of each task the author had to do — as it would sit on a ticket — and nest the steps of a large task inside it. Order tasks in the order they had to be done.',
    nodeKinds: ['task', 'step'],
    edgeKinds: ['blocks', 'follows']
  },
  {
    id: 'data-flow',
    label: 'Data flow',
    hint: 'How data moves through the change',
    focus:
      'Make a node of each stage data passes through — an input, a handler, a transform, a store, a view — and nest the pieces of a stage inside it. Edges follow the data from where it comes from to where it goes.',
    nodeKinds: ['source', 'stage', 'store', 'sink'],
    edgeKinds: ['feeds', 'reads', 'writes']
  },
  {
    id: 'data-models',
    label: 'Data models',
    hint: 'The schemas, tables and types, and who uses them',
    focus:
      'Make a node of each data model the change adds or changes — a table, a schema, a type, a message — and nest its fields or migrations inside it when they are worth reviewing apart. Code that only uses a model belongs to a "users of" node beside it.',
    nodeKinds: ['model', 'field', 'migration', 'users'],
    edgeKinds: ['references', 'migrates', 'reads', 'writes']
  },
  {
    id: 'classes',
    label: 'Class links',
    hint: 'Modules, classes and functions, and how they call each other',
    focus:
      'Make a node of each module the change touches, and nest its classes and functions inside it. Edges are calls, inheritance and imports between them.',
    nodeKinds: ['module', 'class', 'function'],
    edgeKinds: ['calls', 'extends', 'imports', 'implements']
  }
]

export const presetSpec = (id: GraphPreset): PresetSpec => GRAPH_PRESETS.find((preset) => preset.id === id) ?? GRAPH_PRESETS[0]!

const BASE = `Draw the change below as a graph a reviewer can walk through; the Graph pane beside the chat draws your answers. The hunks below are usually enough; when one needs more context, read the code with your file-reading and search tools rather than shell commands, so nothing waits on the user's approval, and keep the reading to what the graph needs. Do not change any files.`

const RULES = `- Every id below (h… for a hunk, f… for a whole file) goes in exactly one node. Keep a file's hunks apart when they belong to different nodes. A node that only gathers others can have no ids of its own.
- Give each node a "ref" (a short slug, unique), a "kind", a short title in plain words, a summary of one to three sentences on what it is and why it changed, and the layers it touches (frontend, backend, database, tests, config, docs, build).
- Nest a node inside another with "parent": the parent's ref. Keep the nesting to what helps a reviewer — two or three levels at most.
- List nodes in the order a reviewer should read them, top-down: a parent before what is inside it, and foundations (schemas, shared types, core logic) before what builds on them.
- Under "edges", note how nodes relate sideways, by ref, with a few words on what passes between them. Leave out nodes that stand alone, and never repeat the nesting as an edge.`

/** The brief a graph conversation opens with: what to draw, how, and then the change itself. */
export function graphPrompt(preset: GraphPreset, parts: { table: string; context?: string[]; instructions?: string }): string {
  const spec = presetSpec(preset)
  const example = JSON.stringify({
    nodes: [
      { ref: 'refunds', kind: spec.nodeKinds[0], title: 'Refund flow', summary: '…', layers: ['backend'], ids: ['h1', 'h4'] },
      { ref: 'refund-form', kind: spec.nodeKinds[1] ?? spec.nodeKinds[0], title: '…', summary: '…', layers: ['frontend'], ids: ['h2', 'f1'], parent: 'refunds' }
    ],
    edges: [{ from: 'refund-form', to: 'refunds', kind: spec.edgeKinds[0], label: 'refund records' }]
  })
  return [
    BASE,
    `This graph is about ${spec.label.toLowerCase()}. ${spec.focus}`,
    `Node kinds to use: ${spec.nodeKinds.join(', ')}. Edge kinds to use, each read "from <kind> to": ${spec.edgeKinds.join(', ')}.`,
    RULES,
    `Reply with a fenced \`\`\`${GRAPH_FENCE} block holding JSON (no comments), then two or three sentences on how you drew it. When asked to change the graph later, reply with the whole updated block, using the same ids. The JSON is shaped like:\n${example}`,
    ...(parts.context ?? []),
    ...(parts.instructions ? [`How the user wants it drawn:\n${parts.instructions}`] : []),
    `The change:\n${parts.table}`
  ].join('\n\n')
}
