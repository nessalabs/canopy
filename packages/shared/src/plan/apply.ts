import type { z } from 'zod'

import { AskDecisionInput, currentVersion, LinkDecisionInput, DrawBoardInput, EditBoardInput, parseBoxKey, SetProgressInput, type Board, type BoardVersion, type BoxNote, type PlanState } from './board'
import { edgeKey, isSynthetic, type Field, type Graph, type GraphNode } from './graph'
import { fragmentOf, parseLines, parseMermaid } from './mermaid'

/**
 * One plan tool call applied to a plan: the same function runs in the daemon, to answer the agent
 * (and refuse a bad drawing so it redraws it), and in the client, to rebuild the plan by replaying
 * a transcript. A call with problems changes nothing.
 */

export interface Applied {
  state: PlanState
  /** Why the call was refused; the plan is unchanged. */
  problems: string[]
  /** Gaps in an accepted board — a missing note, a long label — for the agent to patch with edit_board rather than resend the board. */
  followUps: string[]
  /** What the agent is told on success — short on purpose, since every reply costs input tokens later. */
  summary: string
}

/** Size limits per board. Past them the agent is told to split, which is the drill-down we want anyway. */
export const LIMITS = { boxes: 9, participants: 6, messages: 12, label: 40, arrow: 24, explain: 400 } as const

const REF = /^[^\s:,]+(:\d+(-\d+)?)?$/

/** A note's `ref` as separate references; a malformed one is a problem, not silently dropped. */
export const refsOf = (note: Pick<BoxNote, 'ref'>): string[] => (note.ref ?? '').split(',').map((ref) => ref.trim()).filter(Boolean)

const sizeProblems = (graph: Graph): string[] => {
  const boxes = graph.nodes.filter((node) => !isSynthetic(node.id)).length
  if (boxes === 0) return ['no boxes; draw at least one']
  if (graph.kind === 'sequence') {
    return [
      ...(graph.edges.length === 0 ? ['no messages; a sequence needs at least one `a ->> b: text`'] : []),
      ...(boxes > LIMITS.participants ? [`${boxes} participants; at most ${LIMITS.participants} — draw the main path here and the rest on a detail board`] : []),
      ...(graph.edges.length > LIMITS.messages ? [`${graph.edges.length} messages; at most ${LIMITS.messages} — follow the main path and its riskiest branch`] : [])
    ]
  }
  return boxes > LIMITS.boxes ? [`${boxes} boxes; at most ${LIMITS.boxes} — group some into one box and draw its inside as a detail board`] : []
}

/** Every box the reader can see on a board: today's picture and the one after the change. */
const boxesOf = (version: Pick<BoardVersion, 'graph' | 'before'>): GraphNode[] => {
  const after = version.graph.nodes
  return [...after, ...(version.before?.nodes ?? []).filter((node) => !after.some((other) => other.id === node.id))]
}

const noteProblems = (nodes: readonly GraphNode[], notes: Record<string, BoxNote>): string[] => {
  const ids = new Set(nodes.map((node) => node.id))
  return [
    ...nodes.filter((node) => !isSynthetic(node.id) && !notes[node.id]).map((node) => `box "${node.id}" has no note; every box needs one that explains it in plain words`),
    ...Object.keys(notes).filter((id) => !ids.has(id)).map((id) => `note "${id}" names no box on the board`),
    ...Object.entries(notes).flatMap(([id, note]) => [
      ...(note.explain.length > LIMITS.explain ? [`note "${id}": explain is ${note.explain.length} characters; keep it to two sentences, or give the box a detail board`] : []),
      ...refsOf(note).filter((ref) => !REF.test(ref)).map((ref) => `note "${id}": ref "${ref}" should be path or path:start-end`)
    ])
  ]
}

const labelProblems = (graph: Graph): string[] => [
  ...graph.nodes.filter((node) => node.label.length > LIMITS.label).map((node) => `box "${node.id}": label is ${node.label.length} characters; use a name of a few words and put the sentence in its note`),
  // A sequence's messages are its content; elsewhere an arrow's label is drawn along a line and has to be short.
  ...(graph.kind === 'sequence' ? [] : graph.edges)
    .filter((edge) => (edge.label?.length ?? 0) > LIMITS.arrow)
    .map((edge) => `arrow "${edgeKey(edge)}": label is ${edge.label!.length} characters; two or three words, at most ${LIMITS.arrow}`)
]

/**
 * What a reader-first board must satisfy, split by what a fix costs. A board too big to read is
 * refused and redrawn; a missing note or a long label is accepted and patched with a small edit,
 * since refusing it would have the agent resend the whole board for one line.
 */
export const checkVersion = (version: BoardVersion): { blocking: string[]; fixable: string[] } => ({
  blocking: [...sizeProblems(version.graph), ...(version.before ? sizeProblems(version.before).map((problem) => `before: ${problem}`) : [])],
  fixable: [...labelProblems(version.graph), ...(version.before ? labelProblems(version.before).map((problem) => `before: ${problem}`) : []), ...noteProblems(boxesOf(version), version.notes)]
})

/** Today's picture, read; it must be the same kind of diagram as the board. */
function readBefore(source: string | undefined, kind: Graph['kind'] | undefined): { before?: Graph; problems: string[] } {
  if (source === undefined) return { problems: [] }
  const parsed = parseMermaid(source)
  const problems = parsed.problems.map((problem) => `before: ${problem}`)
  if (kind && parsed.graph.kind !== kind) problems.push(`before: draw today's picture as the same kind of diagram as the board (${kind})`)
  return { before: parsed.graph, problems }
}

const sameNode = (a: GraphNode | undefined, b: GraphNode): boolean => a !== undefined && JSON.stringify(a) === JSON.stringify(b)

/** Boxes that are new or different in `next` — their drawing or their note. */
export const changedBoxes = (previous: BoardVersion | undefined, next: BoardVersion): string[] =>
  previous
    ? next.graph.nodes
        .filter((node) => !sameNode(previous.graph.nodes.find((old) => old.id === node.id), node) || JSON.stringify(previous.notes[node.id]) !== JSON.stringify(next.notes[node.id]))
        .map((node) => node.id)
    : []

const withVersion = (state: PlanState, board: Board, version: BoardVersion): PlanState => ({
  ...state,
  boards: { ...state.boards, [board.id]: { ...board, versions: [...board.versions, version] } },
  order: state.order.includes(board.id) ? state.order : [...state.order, board.id],
  drawings: state.drawings + 1
})

const parentProblems = (state: PlanState, parent: string | undefined, id: string): string[] => {
  if (parent === undefined) return []
  const ref = parseBoxKey(parent)
  const board = ref && state.boards[ref.board]
  if (!ref || !board) return [`parent "${parent}" should be "board/box" naming a board already drawn`]
  if (ref.board === id) return ['a board cannot be its own parent']
  return currentVersion(board).graph.nodes.some((node) => node.id === ref.box) ? [] : [`board "${ref.board}" has no box "${ref.box}"`]
}

const failed = (state: PlanState, problems: string[]): Applied => ({ state, problems, followUps: [], summary: '' })

const accepted = (state: PlanState, summary: string, followUps: string[]): Applied => ({ state, problems: [], followUps, summary })

/** What the agent reads back: the one line, and what is left to patch — the call's own gaps and any the caller adds, such as files not in the checkout. */
export const planReply = (applied: Applied, gaps: readonly string[] = []): string => {
  const all = [...applied.followUps, ...gaps]
  return all.length === 0 ? applied.summary : `${applied.summary} Patch with edit_board (send only these):\n- ${all.join('\n- ')}`
}

/** Detail boards hanging from boxes a redraw or edit took off the board. */
const orphanProblems = (state: PlanState, id: string, graph: Graph): string[] =>
  Object.values(state.boards)
    .filter((board) => board.parent?.board === id && !graph.nodes.some((node) => node.id === board.parent!.box))
    .map((board) => `box "${board.parent!.box}" opened detail board "${board.id}"; keep the box, or redraw "${board.id}" with another parent`)

function drawBoard(state: PlanState, input: DrawBoardInput): Applied {
  const parsed = parseMermaid(input.mermaid)
  const today = readBefore(input.before, parsed.graph.kind)
  const existing = state.boards[input.id]
  const parent = input.parent ? parseBoxKey(input.parent) : existing?.parent
  const board: Board = { id: input.id, ...(parent ? { parent } : {}), versions: existing?.versions ?? [] }
  const version: BoardVersion = { title: input.title, story: input.story, graph: parsed.graph, ...(today.before ? { before: today.before } : {}), notes: input.notes, changed: [] }
  version.changed = changedBoxes(existing && currentVersion(existing), version)
  const { blocking, fixable } = checkVersion(version)
  const problems = [...parsed.problems, ...today.problems, ...parentProblems(state, input.parent, input.id), ...blocking]
  if (problems.length > 0) return failed(state, problems)
  const next = withVersion(state, board, version)
  const boxes = parsed.graph.nodes.filter((node) => !isSynthetic(node.id)).length
  return accepted(next, `Drawn: board "${input.id}" v${board.versions.length + 1}, ${boxes} boxes.`, [...fixable, ...orphanProblems(state, input.id, parsed.graph)])
}

/**
 * Lines of an edit merged into a graph. A box the lines define replaces that box; an arrow replaces
 * every arrow between the same two boxes. A sequence's messages are an ordered story, so new ones
 * replace the whole list rather than being matched up.
 */
const withFields = (node: GraphNode, added: readonly Field[] | undefined): GraphNode =>
  added ? { ...node, fields: [...(node.fields ?? []), ...added.filter((field) => !node.fields?.some((known) => known.name === field.name))] } : node

export function mergeGraph(base: Graph, fragment: Graph, defined: readonly string[], remove: readonly string[]): { graph: Graph; problems: string[] } {
  const nodeIds = new Set(base.nodes.map((node) => node.id))
  const edgeKeys = new Set(base.edges.map(edgeKey))
  const problems = remove.filter((key) => !nodeIds.has(key) && !edgeKeys.has(key)).map((key) => `remove: "${key}" is not a box or arrow on the board`)
  const gone = new Set(remove)

  const replaced = new Map(fragment.nodes.filter((node) => defined.includes(node.id) || !nodeIds.has(node.id)).map((node) => [node.id, node]))
  // A member line names a box without defining it: its fields are added to the box, not put in its place.
  const extended = new Map(fragment.nodes.filter((node) => !replaced.has(node.id) && node.fields).map((node) => [node.id, node.fields!]))
  const nodes = [...base.nodes.map((node) => replaced.get(node.id) ?? withFields(node, extended.get(node.id))), ...[...replaced.values()].filter((node) => !nodeIds.has(node.id))].filter((node) => !gone.has(node.id))

  const redrawn = new Set(fragment.edges.map(edgeKey))
  const kept = base.kind === 'sequence' && fragment.edges.length > 0 ? [] : base.edges.filter((edge) => !redrawn.has(edgeKey(edge)))
  const live = new Set(nodes.map((node) => node.id))
  const edges = [...kept, ...fragment.edges].filter((edge) => !gone.has(edgeKey(edge)) && live.has(edge.from) && live.has(edge.to))
  return { graph: { kind: base.kind, nodes, edges }, problems }
}

const mergeNotes = (notes: Record<string, BoxNote>, changes: Record<string, BoxNote | null> = {}, removed: readonly string[] = []): Record<string, BoxNote> =>
  Object.fromEntries(
    Object.entries({ ...notes, ...changes }).filter((entry): entry is [string, BoxNote] => entry[1] !== null && !removed.includes(entry[0]))
  )

function editBoard(state: PlanState, input: EditBoardInput): Applied {
  const board = state.boards[input.id]
  if (!board) return failed(state, [`no board "${input.id}"; draw it with draw_board first`])
  const current = currentVersion(board)
  const fragment = parseLines(current.graph.kind, fragmentOf(current.graph.kind, input.mermaid ?? ''))
  const merged = mergeGraph(current.graph, fragment.graph, fragment.defined, input.remove ?? [])
  const today = readBefore(input.before, current.graph.kind)
  const before = today.before ?? current.before
  const version: BoardVersion = {
    title: input.title ?? current.title,
    story: input.story ?? current.story,
    graph: merged.graph,
    ...(before ? { before } : {}),
    notes: mergeNotes(current.notes, input.notes, input.remove),
    changed: []
  }
  version.changed = changedBoxes(current, version)
  const { blocking, fixable } = checkVersion(version)
  const problems = [...fragment.problems, ...today.problems, ...merged.problems, ...blocking]
  if (problems.length > 0) return failed(state, problems)
  const next = withVersion(state, board, version)
  return accepted(next, `Edited: board "${input.id}" v${board.versions.length + 1}, changed ${version.changed.join(', ') || 'text only'}.`, [...fixable, ...orphanProblems(state, input.id, merged.graph)])
}

function setProgress(state: PlanState, input: SetProgressInput): Applied {
  const marks = [...(input.doing ?? []).map((key) => [key, 'doing'] as const), ...(input.done ?? []).map((key) => [key, 'done'] as const)]
  const unknown = marks.filter(([key]) => !boxExists(state, key))
  if (unknown.length > 0) return failed(state, unknown.map(([key]) => `"${key}" is not a box; write "board/box"`))
  return accepted({ ...state, progress: { ...state.progress, ...Object.fromEntries(marks) } }, `Marked ${marks.length}.`, [])
}

/** Whether `board/box` names a box on a board's current picture. */
const boxExists = (state: PlanState, key: string): boolean => {
  const ref = parseBoxKey(key)
  const board = ref && state.boards[ref.board]
  return board !== undefined && currentVersion(board).graph.nodes.some((node) => node.id === ref!.box)
}

function askDecision(state: PlanState, input: AskDecisionInput): Applied {
  const pictures = input.options.flatMap((option) => (option.mermaid ? parseMermaid(option.mermaid).problems.map((problem) => `option "${option.id}" picture: ${problem}`) : []))
  const ids = input.options.map((option) => option.id)
  const problems = [
    ...(state.order.length === 0 ? ['draw the overview board first: the reader decides with the picture in front of them'] : []),
    ...(input.about && !boxExists(state, input.about) ? [`about "${input.about}" is not a box; write "board/box"`] : []),
    ...(new Set(ids).size !== ids.length ? ['option ids must differ'] : []),
    ...(input.options.filter((option) => option.recommended).length > 1 ? ['recommend one option at most'] : []),
    ...pictures
  ]
  if (problems.length > 0) return failed(state, problems)
  const previous = state.decisions[input.id]
  return accepted(
    { ...state, decisions: { ...state.decisions, [input.id]: { ...input, ...(previous?.answer ? { answer: previous.answer } : {}) } } },
    `Posted decision "${input.id}". End your turn now; the reader answers on the board and the answer comes back as a message.`,
    []
  )
}

function linkDecision(state: PlanState, input: LinkDecisionInput): Applied {
  const bad = refsOf(input).filter((ref) => !REF.test(ref))
  if (bad.length > 0) return failed(state, bad.map((ref) => `ref "${ref}" should be path or path:start-end`))
  const { decision, ...link } = input
  return accepted({ ...state, links: { ...state.links, [decision]: link } }, 'Linked.', [])
}

/** Each plan tool by its bare name: how its input is read and what it does. */
const TOOLS = {
  draw_board: { schema: DrawBoardInput, apply: drawBoard },
  edit_board: { schema: EditBoardInput, apply: editBoard },
  set_progress: { schema: SetProgressInput, apply: setProgress },
  ask_decision: { schema: AskDecisionInput, apply: askDecision },
  link_decision: { schema: LinkDecisionInput, apply: linkDecision }
} as const

export type PlanTool = keyof typeof TOOLS
export const PLAN_TOOL_NAMES = Object.keys(TOOLS) as PlanTool[]
export const isPlanTool = (name: string): name is PlanTool => Object.hasOwn(TOOLS, name)
export const planToolSchema = (name: PlanTool): z.ZodObject => TOOLS[name].schema as unknown as z.ZodObject

/** A plan tool call applied — input read with the tool's schema first, so a malformed call is a problem list too. */
export function applyCall(state: PlanState, name: PlanTool, input: unknown): Applied {
  const { schema, apply } = TOOLS[name]
  const parsed = schema.safeParse(input)
  if (!parsed.success) return failed(state, parsed.error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`))
  return (apply as (state: PlanState, input: unknown) => Applied)(state, parsed.data)
}

/** Notes citing files that are not in the checkout — unless the box is new and its file is yet to be written. */
export const refProblems = (notes: Record<string, BoxNote | null> | undefined, exists: (path: string) => boolean): string[] =>
  Object.entries(notes ?? {}).flatMap(([id, note]) =>
    note && note.status !== 'new'
      ? refsOf(note)
          .map((ref) => ref.split(':')[0]!)
          .filter((path) => !exists(path))
          .map((path) => `note "${id}": "${path}" is not in this checkout; cite a file you read (path from the repository root), or mark the box new`)
      : []
  )
