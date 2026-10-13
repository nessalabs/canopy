import type { AgentEvent } from '../agent-stream'
import { applyCall, isPlanTool, type PlanTool } from './apply'
import { EMPTY_PLAN, type PlanState } from './board'
import { parseWhiteboardMessage, type WhiteboardMessage } from './messages'

/**
 * A plan is never stored on its own: it is what the session's plan tool calls add up to, replayed
 * in the order they finished. So reopening a session, rejoining a running turn and walking its
 * history all come with the transcript the Agent tab already loads.
 */

/** The in-process MCP server the plan tools are served from; Claude names them `mcp__canopy__<tool>`. */
export const PLAN_SERVER = 'canopy'

const PREFIX = `mcp__${PLAN_SERVER}__`

export const qualifiedPlanTool = (name: PlanTool): string => `${PREFIX}${name}`

/** A call's plan tool, from its qualified name, or undefined for any other tool. */
export const planToolOf = (name: string): PlanTool | undefined => {
  const bare = name.startsWith(PREFIX) ? name.slice(PREFIX.length) : undefined
  return bare !== undefined && isPlanTool(bare) ? bare : undefined
}

export interface Asked {
  /** The prompt's event id, which the turn it started is found by. */
  id: string
  /** Where it sits in the session, for putting everything asked in order. */
  seq: number
  message: WhiteboardMessage
}

/** A question the agent asked in the chat, and what the reader answered, by question. */
export interface ChatQuestions {
  callId: string
  seq: number
  questions: Array<{ question: string; header?: string }>
  answers?: Record<string, string>
}

export interface PlanView {
  state: PlanState
  /** The user messages asked about each box, by `board/box`, as event ids in order. */
  threads: Record<string, string[]>
  /** Every question asked from the whiteboard — about a box, a passage or a decision — in order. */
  asked: Asked[]
  /** A plan tool call still running, so the board can show it is being drawn. */
  drawing: boolean
  /** How many times a plan was approved (`ExitPlanMode` allowed); each one starts a build. */
  approvals: number
  /** The plan document the agent asked approval with, newest last. */
  document?: string
  /** The questions the agent asked in the chat, in order. */
  questions: ChatQuestions[]
}

export const EMPTY_VIEW: PlanView = { state: EMPTY_PLAN, threads: {}, asked: [], drawing: false, approvals: 0, questions: [] }

const EXIT_PLAN = 'ExitPlanMode'
const ASK = 'AskUserQuestion'

/** The questions an `AskUserQuestion` call asks. */
const askedQuestions = (input: unknown): ChatQuestions['questions'] => {
  const list = (input as { questions?: unknown } | null)?.questions
  return Array.isArray(list)
    ? list.flatMap((entry: { question?: unknown; header?: unknown }) => (typeof entry?.question === 'string' ? [{ question: entry.question, ...(typeof entry.header === 'string' ? { header: entry.header } : {}) }] : []))
    : []
}

/** The answers Claude Code reports back: `"question"="answer"` pairs. */
export const answersIn = (result: string): Record<string, string> =>
  Object.fromEntries([...result.matchAll(/"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g)].map(([, question, answer]) => [unescaped(question!), unescaped(answer!)]))

/** The text inside a quoted pair, with its `\"` and `\\` escapes undone, so it matches the question as asked. */
const unescaped = (text: string): string => text.replace(/\\(.)/g, '$1')

/** What a reader's message does to the plan: their choices settle those decisions. */
function readerSaid(state: PlanState, message: WhiteboardMessage): PlanState {
  if (message.kind !== 'decision') return state
  const decisions = { ...state.decisions }
  for (const { id, option, note } of message.choices) if (decisions[id]) decisions[id] = { ...decisions[id]!, answer: { option, ...(note ? { note } : {}) } }
  return { ...state, decisions }
}

/** The plan an `ExitPlanMode` call carries. */
const planText = (input: unknown): string | undefined => {
  const plan = (input as { plan?: unknown } | null)?.plan
  return typeof plan === 'string' && plan.trim() ? plan : undefined
}

/** What the fold carries between events: calls still running, and which of them leave plan mode. */
interface Fold {
  view: PlanView
  started: Map<string, { tool: PlanTool; input: unknown }>
  exits: Set<string>
}

type Payload<T extends AgentEvent['payload']['type']> = Extract<AgentEvent['payload'], { type: T }>

/** Each event kind the plan moves on, and how. */
const STEPS: { [T in 'tool_call_started' | 'tool_call_completed' | 'user_message']: (fold: Fold, payload: Payload<T>, event: AgentEvent) => void } = {
  tool_call_started: ({ view, started, exits }, payload, event) => {
    const tool = planToolOf(payload.name)
    if (tool) started.set(payload.callId, { tool, input: payload.input })
    if (payload.name === ASK) view.questions.push({ callId: payload.callId, seq: event.seq, questions: askedQuestions(payload.input) })
    if (payload.name !== EXIT_PLAN) return
    exits.add(payload.callId)
    view.document = planText(payload.input) ?? view.document
  },
  tool_call_completed: ({ view, started, exits }, payload) => {
    const call = started.get(payload.callId)
    started.delete(payload.callId)
    if (payload.result.isError) return
    const asked = view.questions.find((entry) => entry.callId === payload.callId)
    if (asked) asked.answers = answersIn(payload.result.text)
    if (exits.has(payload.callId)) view.approvals += 1
    if (call) view.state = applyCall(view.state, call.tool, call.input).state
  },
  user_message: ({ view }, payload, { id, seq }) => {
    const message = parseWhiteboardMessage(payload.text)
    if (!message) return
    view.asked.push({ id, seq, message })
    if (message.kind === 'box') (view.threads[message.ref] ??= []).push(id)
    view.state = readerSaid(view.state, message)
  }
}

/** The plan a transcript describes. Only the main conversation draws; a subagent's calls are its own. */
export function foldPlan(events: readonly AgentEvent[]): PlanView {
  const fold: Fold = { view: { ...EMPTY_VIEW, threads: {}, asked: [], questions: [] }, started: new Map(), exits: new Set() }
  for (const event of events) {
    const step = STEPS[event.payload.type as keyof typeof STEPS] as ((fold: Fold, payload: AgentEvent['payload'], event: AgentEvent) => void) | undefined
    if (step && event.agentPath.length === 0) step(fold, event.payload, event)
  }
  return { ...fold.view, drawing: fold.started.size > 0 }
}
