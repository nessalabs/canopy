import { currentVersion, parseBoxKey, parseWhiteboardMessage, refsOf, type Asked, type Decision, type PlanView, type WhiteboardMessage, type Board, type BoardVersion, type BoxNote, type BoxRef, type GraphNode, type PlanState, type ProgressStatus, type WhiteboardMode } from '@canopy/shared'
import type { Turn } from '@canopy/shared/agent-stream'
import { AgentEventType, isEvent } from '@canopy/shared/agent-stream'
import { readStored as readAny } from './local-store'

/**
 * The whiteboard as the Agent tab lays it out, without React: where each board sits on the canvas,
 * the outline of boards, what a picked box says, and the Q&A asked about it.
 */

/** Room a board takes before it has been measured, and the space kept between boards. */
export const BOARD_SIZE = { width: 760, height: 640, gap: 96 } as const

export interface Placed {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

const childrenOf = (state: PlanState, id: string | undefined): string[] =>
  state.order.filter((boardId) => {
    const parent = state.boards[boardId]!.parent?.board
    return id === undefined ? parent === undefined || state.boards[parent] === undefined : parent === id
  })

/**
 * A tidy tree, left to right: the overview first, each board's detail boards in the column after
 * it, a parent level with its first child. Columns are as wide as their widest board and subtrees
 * stack under each other, so boards never overlap whatever size they are drawn at.
 */
export function layoutBoards(state: PlanState, sizes: Readonly<Record<string, Size>> = {}): Record<string, Placed> {
  const size = (id: string): Size => sizes[id] ?? BOARD_SIZE
  const depths: Record<string, number> = {}
  const walk = (id: string, depth: number): void => {
    depths[id] = depth
    childrenOf(state, id).forEach((kid) => walk(kid, depth + 1))
  }
  const roots = childrenOf(state, undefined)
  roots.forEach((root) => walk(root, 0))
  const columns: number[] = []
  for (const [id, depth] of Object.entries(depths)) columns[depth] = Math.max(columns[depth] ?? 0, size(id).width)
  const columnX = (depth: number): number => columns.slice(0, depth).reduce((x, width) => x + width + BOARD_SIZE.gap, 0)

  const placed: Record<string, Placed> = {}
  /** Places a subtree with its top at `top`; answers where the next subtree may start. */
  const place = (id: string, top: number): number => {
    placed[id] = { x: columnX(depths[id]!), y: top }
    const below = childrenOf(state, id).reduce((y, kid) => place(kid, y), top)
    return Math.max(below, top + size(id).height + BOARD_SIZE.gap)
  }
  roots.reduce((y, root) => place(root, y), 0)
  return placed
}

export interface OutlineEntry {
  id: string
  title: string
  depth: number
  /** The box the board looks inside, by its label on the parent board. */
  via?: string
}

/** Every board in reading order, indented under the box it opens. */
export function boardOutline(state: PlanState): OutlineEntry[] {
  const walk = (id: string, depth: number): OutlineEntry[] => {
    const board = state.boards[id]!
    const parent = board.parent && state.boards[board.parent.board]
    const via = parent && currentVersion(parent).graph.nodes.find((node) => node.id === board.parent!.box)?.label
    return [{ id, title: currentVersion(board).title, depth, ...(via ? { via } : {}) }, ...childrenOf(state, id).flatMap((kid) => walk(kid, depth + 1))]
  }
  return childrenOf(state, undefined).flatMap((root) => walk(root, 0))
}

/** The detail board drawn for a box, if any. */
export const detailBoard = (state: PlanState, ref: BoxRef): Board | undefined => Object.values(state.boards).find((board) => board.parent?.board === ref.board && board.parent.box === ref.box)

export interface BoxInfo {
  ref: BoxRef
  node: GraphNode
  note?: BoxNote
  refs: string[]
  progress?: ProgressStatus
  detail?: string
}

/** What a picked box says, read from the version on screen. */
export function boxInfo(state: PlanState, ref: BoxRef, version?: BoardVersion): BoxInfo | undefined {
  const board = state.boards[ref.board]
  const shown = version ?? (board && currentVersion(board))
  const node = shown?.graph.nodes.find((candidate) => candidate.id === ref.box)
  if (!shown || !node) return undefined
  const note = shown.notes[ref.box]
  return { ref, node, note, refs: note ? refsOf(note) : [], progress: state.progress[`${ref.board}/${ref.box}`], detail: detailBoard(state, ref)?.id }
}

const PROGRESS_LINE: Record<ProgressStatus, string> = { doing: 'In progress…', done: 'Done ✓' }

/** How far each box of a board has got, by box id. */
export const progressOn = (state: PlanState, boardId: string): Record<string, ProgressStatus> =>
  Object.fromEntries(Object.entries(state.progress).flatMap(([key, status]) => (key.startsWith(`${boardId}/`) ? [[key.slice(boardId.length + 1), status]] : [])))

/**
 * Each box's second line on a board, most pressing first: how far its build has got, a decision
 * waiting on the reader, a detail board it opens.
 */
export function boxLines(state: PlanState, boardId: string): Record<string, string> {
  const lines: Record<string, string> = {}
  const mark = (box: string | undefined, line: string): void => {
    if (box && !lines[box]) lines[box] = line
  }
  for (const [box, status] of Object.entries(progressOn(state, boardId))) mark(box, PROGRESS_LINE[status])
  for (const decision of Object.values(state.decisions)) if (!decision.answer && decision.about?.startsWith(`${boardId}/`)) mark(decision.about.slice(boardId.length + 1), 'Needs your decision')
  for (const board of Object.values(state.boards)) if (board.parent?.board === boardId) mark(board.parent.box, 'Opens a detail board ↗')
  return lines
}

/** The boxes a passage talks about: those whose label it names (labels of a word or two are matched whole). */
export function mentionedBoxes(text: string, nodes: readonly GraphNode[]): string[] {
  const plain = text.toLowerCase()
  const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [...new Set(nodes.filter((node) => node.label.length >= 3 && new RegExp(`(^|\\W)${escape(node.label.toLowerCase())}(\\W|$)`).test(plain)).map((node) => node.id))]
}

/** The decisions shown on a board: those about its boxes, and on the first board those about nothing in particular. */
export const decisionsOn = (state: PlanState, boardId: string): Decision[] =>
  Object.values(state.decisions).filter((decision) => (decision.about ? parseBoxKey(decision.about)?.board === boardId : state.order[0] === boardId))

/** How far a build has got: boxes done and in progress out of those marked at all. */
export function progressSummary(state: PlanState): { done: number; doing: number } {
  const marks = Object.values(state.progress)
  return { done: marks.filter((mark) => mark === 'done').length, doing: marks.filter((mark) => mark === 'doing').length }
}

/** What "go deeper" sends the agent; shown to the reader as the button they pressed. */
export const DEEPER = 'Go deeper: read the code behind this box and draw what is inside it as a detail board.'

/** The words of a box question as the reader asked them. */
export const boxQuestion = (text: string): string => (text.trim() === DEEPER ? 'Go deeper' : text.trim())

export interface ThreadEntry {
  id: string
  question: string
  answer: string | null
}

/** A whiteboard message as the reader wrote it: the question, or the choice they made. */
const QUESTION_OF: { [K in WhiteboardMessage['kind']]: (message: Extract<WhiteboardMessage, { kind: K }>) => string } = {
  box: (message) => boxQuestion(message.text),
  quote: (message) => message.text.trim(),
  decision: (message) => message.choices.map((choice) => `Chose “${choice.label}”${choice.note ? ` — ${choice.note}` : ''}`).join('; ')
}

const questionOf = (message: WhiteboardMessage): string => (QUESTION_OF[message.kind] as (message: WhiteboardMessage) => string)(message)

/** The questions behind `eventIds`, each with the answer the turn it started ended on. */
export function threadOf(turns: readonly Turn[], eventIds: readonly string[] | undefined): ThreadEntry[] {
  if (!eventIds?.length) return []
  return turns.flatMap((turn) => {
    const prompt = turn.prompt
    if (!prompt || !eventIds.includes(prompt.id) || !isEvent(prompt, AgentEventType.UserMessage)) return []
    const message = parseWhiteboardMessage(prompt.payload.text)
    return [{ id: prompt.id, question: message ? questionOf(message) : prompt.payload.text, answer: turn.finalText }]
  })
}

/** The questions asked about one selected passage, by the event ids that asked them. */
export const quoteAsks = (asked: readonly Asked[], ref: string, quote: string): string[] =>
  asked.flatMap(({ id, message }) => (message.kind === 'quote' && message.ref === ref && message.quote === quote ? [id] : []))

// ---- the decision trail ----

export interface TrailEntry {
  key: string
  kind: 'you-asked' | 'claude-asked' | 'decision'
  question: string
  answer?: string
  /** How it was built and where, once the agent linked it. */
  built?: { how: string; ref: string }
  seq: number
}

/** A link's code references, one per file. */
export const refsOfLink = (link: { ref: string }): string[] => refsOf(link)

/** A long answer cut to its first paragraph: the trail is for scanning, the thread has the rest. */
const gist = (text: string | null | undefined): string | undefined => {
  const first = text?.trim().split(/\n\s*\n/)[0]
  return first ? (first.length > 280 ? `${first.slice(0, 277)}…` : first) : undefined
}

const YOU_ASKED: Partial<Record<WhiteboardMessage['kind'], (message: WhiteboardMessage) => string>> = {
  box: (message) => (message.kind === 'box' ? `About “${message.label}”: ${boxQuestion(message.text)}` : ''),
  quote: (message) => (message.kind === 'quote' ? `“${message.quote}” — ${message.text.trim()}` : '')
}

/**
 * Everything asked in the session, in order: the reader's questions with what the agent answered,
 * the agent's questions with what the reader picked, the decisions on the board — each with how it
 * was built once the agent linked it to code.
 */
export function trailOf(view: PlanView, turns: readonly Turn[]): TrailEntry[] {
  const { links, decisions } = view.state
  const answerOf = (eventId: string): string | undefined => gist(turns.find((turn) => turn.prompt?.id === eventId)?.finalText)
  const decidedAt = new Map(view.asked.flatMap(({ seq, message }) => (message.kind === 'decision' ? message.choices.map((choice) => [choice.id, seq] as const) : [])))
  const yours = view.asked.flatMap(({ id, seq, message }): TrailEntry[] => {
    const question = YOU_ASKED[message.kind]?.(message)
    return question ? [{ key: id, kind: 'you-asked', question, answer: answerOf(id), seq }] : []
  })
  const theirs = view.questions.flatMap(({ callId, seq, questions, answers }) =>
    questions.map(({ question }, at): TrailEntry => ({ key: `${callId}:${at}`, kind: 'claude-asked', question, answer: answers?.[question], built: links[question], seq }))
  )
  const decided = Object.values(decisions).map((decision): TrailEntry => {
    const chosen = decision.options.find((option) => option.id === decision.answer?.option)
    return {
      key: `decision:${decision.id}`,
      kind: 'decision',
      question: decision.question,
      answer: chosen ? `${chosen.label}${decision.answer?.note ? ` — “${decision.answer.note}”` : ''}` : undefined,
      built: links[decision.id],
      seq: decidedAt.get(decision.id) ?? Number.MAX_SAFE_INTEGER
    }
  })
  return [...yours, ...theirs, ...decided].sort((a, b) => a.seq - b.seq)
}

// ---- walking through the plan ----

export interface TourStep {
  board: string
  /** A box on that board; absent for the step that introduces the board itself. */
  box?: string
  title: string
  text: string
}

/** The plan in reading order: each board introduced by its story's first paragraph, then each of its boxes. */
export function tourSteps(state: PlanState): TourStep[] {
  return boardOutline(state).flatMap(({ id }) => {
    const version = currentVersion(state.boards[id]!)
    const intro: TourStep = { board: id, title: version.title, text: version.story.split(/\n\s*\n/)[0] ?? '' }
    const boxes = version.graph.nodes.flatMap((node): TourStep[] => {
      const note = version.notes[node.id]
      return note ? [{ board: id, box: node.id, title: node.label, text: note.explain }] : []
    })
    return [intro, ...boxes]
  })
}

// ---- the reader's notes on boxes ----

/** Notes by `board/box`, each a list in the order written. */
export type BoxNotes = Readonly<Record<string, readonly string[]>>

export const notesCount = (notes: BoxNotes): number => Object.values(notes).reduce((count, list) => count + list.length, 0)

/** Every note as one message: each under the box it is about, by name and address. */
export function notesMessage(state: PlanState, notes: BoxNotes): { title: string; brief: string } {
  const lines = Object.entries(notes).flatMap(([key, list]) => {
    const ref = parseBoxKey(key)
    const board = ref && state.boards[ref.board]
    const label = (board && currentVersion(board).graph.nodes.find((node) => node.id === ref!.box)?.label) ?? key
    return list.length > 0 ? [`On “${label}” (${key}):`, ...list.map((note) => `- ${note}`)] : []
  })
  const count = notesCount(notes)
  return {
    title: `My notes on the plan (${count})`,
    brief: [`I read the plan and left ${count === 1 ? 'a note' : 'notes'} on some boxes. Answer each one in plain words, and change the boards where a note changes the plan.`, '', ...lines].join('\n')
  }
}

/** The mode the next turn runs in: a plan once approved is being built. */
export const nextMode = (mode: WhiteboardMode | undefined, approved: boolean): WhiteboardMode | undefined => (mode === 'plan' && approved ? 'build' : mode)

/** What a box's code reference opens: the path, and the lines when the ref names them. */
export function refTarget(ref: string): { path: string; lines?: string } {
  const [path, lines] = ref.split(':')
  return { path: path!, ...(lines ? { lines } : {}) }
}

// ---- what is remembered per session, in this browser ----

function readStored<T>(key: string, valid: (value: unknown) => value is T): T | undefined {
  const value = readAny<unknown>(key)
  return valid(value) ? value : undefined
}

function writeStored(key: string, value: unknown): void {
  try {
    if (value === undefined) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage unavailable: nothing is remembered across reloads.
  }
}

const MODES: ReadonlySet<unknown> = new Set(['explain', 'plan', 'build'])
const isMode = (value: unknown): value is WhiteboardMode => MODES.has(value)
const isNotes = (value: unknown): value is BoxNotes =>
  typeof value === 'object' && value !== null && Object.values(value).every((list) => Array.isArray(list) && list.every((note) => typeof note === 'string'))

/** The whiteboard mode a session's turns run in. */
export const readMode = (sessionId: string | undefined): WhiteboardMode | undefined => (sessionId ? readStored(`canopy-whiteboard:${sessionId}`, isMode) : undefined)
export const writeMode = (sessionId: string, mode: WhiteboardMode | undefined): void => writeStored(`canopy-whiteboard:${sessionId}`, mode)

/** Where the reader dragged a session's boards, by board id. */
export type BoardLayout = Record<string, { x: number; y: number }>
const isLayout = (value: unknown): value is BoardLayout =>
  typeof value === 'object' && value !== null && Object.values(value).every((at) => typeof at === 'object' && at !== null && typeof (at as { x: unknown }).x === 'number' && typeof (at as { y: unknown }).y === 'number')
export const readLayout = (sessionId: string | undefined): BoardLayout => (sessionId ? readStored(`canopy-whiteboard-layout:${sessionId}`, isLayout) : undefined) ?? {}
export const writeLayout = (sessionId: string, layout: BoardLayout): void => writeStored(`canopy-whiteboard-layout:${sessionId}`, Object.keys(layout).length > 0 ? layout : undefined)

/** The notes the reader is writing on a session's boxes, kept until they are sent. */
export const readNotes = (sessionId: string | undefined): BoxNotes => (sessionId ? readStored(`canopy-whiteboard-notes:${sessionId}`, isNotes) : undefined) ?? {}
export const writeNotes = (sessionId: string, notes: BoxNotes): void => writeStored(`canopy-whiteboard-notes:${sessionId}`, notesCount(notes) > 0 ? notes : undefined)

// ---- the canvas view ----

/** What each mode is called while it is on. */
export const MODE_WORD: Record<WhiteboardMode, string> = { explain: 'Explaining', plan: 'Planning', build: 'Building' }

export interface Rect extends Placed, Size {}

/** Where the canvas is looking: its offset on screen and its zoom. */
export interface Viewport {
  x: number
  y: number
  zoom: number
}

const MARGIN = 48
const ZOOM = { min: 0.25, max: 2 } as const

/** Where the canvas looks before it knows its own size. */
export const START_VIEW: Viewport = { x: MARGIN, y: MARGIN, zoom: 0.8 }

/** The smallest zoom one board is shown at, so its text can be read. */
export const READABLE = 0.7

/**
 * A viewport showing `box` (canvas units) inside a `width`×`height` view: as large as fits, up to
 * full size, but never below `floor`. One board is shown at a size its text can be read at — a
 * board wider than the view lines up on its left edge and pans — while "fit every board" may go
 * as small as it takes.
 */
export function viewportFor(box: Rect, width: number, height: number, floor: number = ZOOM.min): Viewport {
  const zoom = Math.max(floor, Math.min(1, (width - MARGIN * 2) / box.width, (height - MARGIN * 2) / box.height))
  const x = box.width * zoom > width - MARGIN * 2 ? MARGIN : (width - box.width * zoom) / 2
  const y = box.height * zoom > height - MARGIN * 2 ? MARGIN : (height - box.height * zoom) / 2
  return { zoom, x: x - box.x * zoom, y: y - box.y * zoom }
}

/** The smallest box holding every placed board. */
export function boundsOf(placed: readonly Rect[]): Rect {
  const x = Math.min(...placed.map((p) => p.x))
  const y = Math.min(...placed.map((p) => p.y))
  return { x, y, width: Math.max(...placed.map((p) => p.x + p.width)) - x, height: Math.max(...placed.map((p) => p.y + p.height)) - y }
}

/** Zooms by `factor` keeping the screen point `center` still. */
export function zoomAround(viewport: Viewport, factor: number, center: Placed): Viewport {
  const zoom = Math.max(ZOOM.min, Math.min(ZOOM.max, viewport.zoom * factor))
  const scale = zoom / viewport.zoom
  return { zoom, x: center.x - (center.x - viewport.x) * scale, y: center.y - (center.y - viewport.y) * scale }
}

/** What the session's turns have cost so far, where the provider reports it. */
export const sessionCost = (turns: readonly Turn[]): number | undefined => {
  const costs = turns.flatMap((turn) => (typeof turn.usage?.totalCostUsd === 'number' ? [turn.usage.totalCostUsd] : []))
  return costs.length > 0 ? costs.reduce((sum, cost) => sum + cost, 0) : undefined
}

/** Only these events can change a plan, so the fold reruns when one of them arrives and not on every streamed token. */
export const PLAN_EVENTS: ReadonlySet<string> = new Set([AgentEventType.ToolCallStarted, AgentEventType.ToolCallCompleted, AgentEventType.UserMessage])
