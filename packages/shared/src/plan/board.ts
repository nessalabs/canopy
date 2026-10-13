import { z } from 'zod'

import type { Graph } from './graph'

/**
 * A plan is a set of boards on a whiteboard. Each board is one diagram (Mermaid, read into a
 * `Graph`) plus the words that make it readable to someone who does not know the system: a story
 * beside it and a note on every box. These are the inputs of the tools the agent draws with, and
 * the state those calls add up to.
 */

/** What a box is to the change. Plain words for the agent; mapped onto the drawings' own statuses. */
export const BoxStatus = z.enum(['new', 'changed', 'removed', 'context', 'risk'])
export type BoxStatus = z.infer<typeof BoxStatus>

export const BoxNote = z.object({
  /** One or two plain sentences: what this is and what the plan does to it. */
  explain: z.string().min(1),
  /** Only where the plan chose between options: the alternative and why not. */
  why: z.string().optional(),
  status: BoxStatus.optional(),
  /** Where its code is: `path`, `path:12-40`, several separated by commas. */
  ref: z.string().optional()
})
export type BoxNote = z.infer<typeof BoxNote>

const BoardId = z.string().regex(/^[\w-]{1,40}$/, 'a short slug: letters, digits, - and _')
/**
 * A map keyed by box id or term. Written as an object with a catch-all rather than `z.record`: the
 * JSON schema a record becomes makes Claude Code drop the server's whole tool list.
 */
const keyed = <T extends z.ZodType>(value: T) => z.object({}).catchall(value)

/**
 * Top-level fields carry no zod defaults: the Agent SDK's MCP bridge rejects a missing field that
 * has one (see the generative-UI experiment), so absent stays absent and readers fill in.
 */
export const DrawBoardInput = z.object({
  id: BoardId,
  /** `board/box`: the box this board looks inside. Absent for the overview. */
  parent: z.string().optional(),
  title: z.string().min(1).max(60),
  story: z.string().min(1),
  mermaid: z.string().min(1),
  /** The same picture as things are today, for a board that shows a change: the reader flips between the two. */
  before: z.string().min(1).optional(),
  notes: keyed(BoxNote)
})
export type DrawBoardInput = z.infer<typeof DrawBoardInput>

export const EditBoardInput = z.object({
  id: BoardId,
  title: z.string().min(1).max(60).optional(),
  story: z.string().min(1).optional(),
  /** Only the lines that add or change boxes and arrows, without the diagram's header. */
  mermaid: z.string().optional(),
  /** Box ids, or `a->b` arrows, to take off the board. */
  remove: z.array(z.string()).optional(),
  /** A whole new "today" picture, replacing the old one. */
  before: z.string().min(1).optional(),
  /** Notes to set; `null` drops one (its box must be removed too). */
  notes: keyed(BoxNote.nullable()).optional()
})
export type EditBoardInput = z.infer<typeof EditBoardInput>

const Slug = z.string().regex(/^[\w-]{1,40}$/, 'a short slug: letters, digits, - and _')

export const DecisionOption = z.object({
  id: Slug,
  /** The choice in a few plain words. */
  label: z.string().min(1).max(60),
  /** What picking it changes, and what it costs, in everyday words. */
  explain: z.string().min(1),
  /** A small picture of how things work with this option (Mermaid, any kind the boards take). */
  mermaid: z.string().min(1).optional(),
  recommended: z.boolean().optional()
})
export type DecisionOption = z.infer<typeof DecisionOption>

/** A choice only the reader can make, put on the board instead of asked in the chat. */
export const AskDecisionInput = z.object({
  id: Slug,
  /** `board/box` the decision is about, so it sits beside that box. */
  about: z.string().optional(),
  question: z.string().min(1).max(160),
  /** What the decision is about and how things work today, for someone who does not know the code. */
  context: z.string().min(1),
  options: z.array(DecisionOption).min(2).max(4)
})
export type AskDecisionInput = z.infer<typeof AskDecisionInput>

export interface Decision extends AskDecisionInput {
  /** The reader's choice, once made. */
  answer?: { option: string; note?: string }
}

/** How a decision the reader made was carried out, and where in the code. */
export const LinkDecisionInput = z.object({
  /** A decision card's id, or a question exactly as it was asked. */
  decision: z.string().min(1),
  /** What was done about it, in one plain sentence. */
  how: z.string().min(1),
  /** The code that carries it out: path or path:start-end, several separated by commas. */
  ref: z.string().min(1)
})
export type LinkDecisionInput = z.infer<typeof LinkDecisionInput>

export const ProgressStatus = z.enum(['doing', 'done'])
export type ProgressStatus = z.infer<typeof ProgressStatus>

export const SetProgressInput = z.object({
  doing: z.array(z.string()).optional(),
  done: z.array(z.string()).optional()
})
export type SetProgressInput = z.infer<typeof SetProgressInput>

/** A box anywhere on the whiteboard: `board/box`. */
export interface BoxRef {
  board: string
  box: string
}

export const boxKey = (ref: BoxRef): string => `${ref.board}/${ref.box}`

export function parseBoxKey(key: string): BoxRef | undefined {
  const slash = key.indexOf('/')
  return slash > 0 && slash < key.length - 1 ? { board: key.slice(0, slash), box: key.slice(slash + 1) } : undefined
}

export interface BoardVersion {
  title: string
  story: string
  graph: Graph
  /** The picture as things are today, when the board shows a change. */
  before?: Graph
  notes: Record<string, BoxNote>
  /** Boxes added or changed since the version before, so the board can outline them. */
  changed: string[]
}

export interface Board {
  id: string
  parent?: BoxRef
  /** Every version drawn, oldest first; the last is current. */
  versions: BoardVersion[]
}

export interface PlanState {
  boards: Record<string, Board>
  /** Board ids in the order they were first drawn. */
  order: string[]
  /** Choices put to the reader, in the order they were asked. */
  decisions: Record<string, Decision>
  /** How each decision was built, by the decision's id or question. */
  links: Record<string, Omit<LinkDecisionInput, 'decision'>>
  /** By `board/box`. */
  progress: Record<string, ProgressStatus>
  /** Accepted drawing calls, for the cost line. */
  drawings: number
}

export const EMPTY_PLAN: PlanState = { boards: {}, order: [], decisions: {}, links: {}, progress: {}, drawings: 0 }

export const currentVersion = (board: Board): BoardVersion => board.versions[board.versions.length - 1]!

/**
 * A readable plan before the agent has written one: every board's story, in the order drawn. Empty
 * while nothing is drawn, so a caller can fall back on it without checking.
 */
export const draftPlan = (state: PlanState): string =>
  state.order.length === 0
    ? ''
    : [
        '# Draft plan',
        '_The agent has not written the plan yet — this is what its boards say so far._',
        ...state.order.map((id) => {
          const { title, story } = currentVersion(state.boards[id]!)
          return `## ${title}\n\n${story}`
        })
      ].join('\n\n')
