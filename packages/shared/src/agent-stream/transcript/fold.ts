/** @responsibility Folds a flat agent event log into the turns, tool groups, delegated runs and pending asks a transcript draws. */

import type {
  AgentEvent,
  AgentPath,
  BlockRef,
  PlanStep,
  SessionInfo,
  ToolResult,
  Usage,
  WorkflowPhaseProgress,
} from "../events"
import { TranscriptBuilder } from "./builder"
import { pathKey } from "../events"
import type { AgentEventType } from "../events"

/** A run of consecutive same-tool calls, collapsed behind one row. */
export interface ToolGroup {
  readonly kind: "tool_group"
  readonly name: string
  readonly calls: readonly AgentEvent[]
  /** Distinct targets across the run — three edits to one file is one target, not three. */
  readonly targets: number
  /** The single target when the whole run hit one, so the row can name it instead of counting to one. */
  readonly target: string | null
  readonly key: string
}

/** Either a lone event or a collapsed run. */
export type WorkItem = AgentEvent | ToolGroup

export function isToolGroup(item: WorkItem): item is ToolGroup {
  return "kind" in item && item.kind === "tool_group"
}

/** One prompt-to-result span of the main conversation. */
export interface Turn {
  readonly key: string
  /** Absent for a transcript that starts mid-conversation, which every resumed session does. */
  readonly prompt: AgentEvent | null
  readonly work: readonly WorkItem[]
  readonly completed: AgentEvent | null
  /**
   * The turn's closing text. `result.result` is a verbatim copy of the last
   * `assistant_text`, so a view that draws both prints the answer twice; a turn
   * that ended without one falls back to that last message directly.
   */
  readonly finalText: string | null
  readonly toolCalls: number
  readonly usage: Usage | null
}

/** One delegated run — a subagent, a workflow, or a backgrounded shell. */
export interface DelegatedRun {
  /** The spawning tool call's id, which is what the envelope path correlates on. */
  readonly callId: string
  /** The harness's own handle. A *different* id from `callId`, and confusing the two fails silently. */
  readonly taskId: string | null
  readonly kind: "agent" | "workflow" | "bash" | "other"
  readonly label: string | null
  readonly description: string | null
  /**
   * The run's own transcript, where the provider named one.
   *
   * Only opencode does: it puts the child session id on the spawning call, and
   * `opencode export <id>` reads it. Null everywhere else, which is what tells
   * a surface whether "open this subagent" is an offer it can honour.
   */
  readonly transcriptId: string | null
  /** Latest progress line, rewritten per event, so it drives a live status row. */
  readonly status: string | null
  readonly lastTool: string | null
  readonly done: boolean
  readonly usage: Usage | null
  /**
   * The run's own events. A subagent reports these; a workflow reports none —
   * its window is `phases` instead, which is a different view rather than no
   * view.
   */
  readonly events: readonly AgentEvent[]
  /**
   * A workflow's phase-and-agent board, latest snapshot. Empty for every other
   * kind of run.
   */
  readonly phases: readonly WorkflowPhaseProgress[]
  /** The run's own plan, when it keeps one. A delegated agent's checklist is not the session's. */
  readonly plan: readonly PlanStep[]
  /** How deep this run sits. `1` is a subagent of the main thread. */
  readonly depth: number
  readonly path: AgentPath
}

export interface Transcript {
  /**
   * Bumped once per absorbed event.
   *
   * The collections below are append-only and keep their identity across
   * snapshots — copying a whole session's events per frame is the cost the
   * incremental fold exists to avoid — so this, not reference equality, is what
   * a consumer memoizes on.
   */
  readonly revision: number
  /** Main-thread events in `seq` order. Delegated work is filed into `runs`; its spawning call stays here. */
  readonly events: readonly AgentEvent[]
  readonly turns: readonly Turn[]
  readonly runs: readonly DelegatedRun[]
  readonly runByCallId: ReadonlyMap<string, DelegatedRun>
  readonly resultByCallId: ReadonlyMap<string, ToolResult>
  /** Calls a later event proved will never get a result, so their rows stop shimmering. */
  readonly abandonedCallIds: ReadonlySet<string>
  /** The agent's plan as last published. Latest wins. */
  readonly plan: readonly PlanStep[]
  readonly session: SessionInfo | null
  /** Every `init` in order — a resumed session contributes one per process, which is where a model change shows up. */
  readonly sessions: readonly SessionInfo[]
  readonly pendingAsks: readonly AgentEvent[]
  readonly usage: Usage | null
}

/**
 * Orders a log by `seq`, without copying it when it already is.
 *
 * A live log is appended to in `seq` order, so the sort is a copy and a sort of
 * the whole session on every fold — and a fold runs on every frame. Checking
 * order first is one linear pass that the common case pays instead of an
 * allocation proportional to the session's whole length.
 *
 * Out-of-order input is still handled: it is only *persisted* logs merged from
 * several sources that arrive shuffled, and those still sort.
 */
function inSeqOrder(source: readonly AgentEvent[]): readonly AgentEvent[] {
  for (let index = 1; index < source.length; index += 1) {
    if (source[index]!.seq < source[index - 1]!.seq) {
      return [...source].sort((a, b) => a.seq - b.seq)
    }
  }
  return source
}

/** How many consecutive same-tool calls collapse into one row. Any repeat groups, so a run reads the same at two calls or thirty. */
export const GROUP_MIN = 2

/**
 * Payload types that put something on screen. What a collapse reveals, and what
 * can break a tool run, is a function of this set.
 *
 * Exported so a host that folds its own way can ask the same question the
 * built-in fold asks, rather than maintaining a second copy of this set that
 * has to be kept in step — a rule nothing enforces and everything eventually
 * breaks.
 *
 * `plan_updated` and `file_edits` are deliberately absent: both draw in their
 * own surface rather than as a row in the work list — the plan in its panel, the
 * changed files as one summary at the end of the turn — so counting either
 * would both overstate a collapse and split a run of calls down the middle.
 */
export const RENDERS: ReadonlySet<AgentEventType> = new Set<AgentEventType>([
  "user_message",
  "assistant_text",
  "reasoning",
  "tool_call_started",
  "error",
  "context_compacted",
  "rate_limited",
  "permission_denied",
  "task_started",
])

export function rendersRow(item: WorkItem): boolean {
  return isToolGroup(item) || RENDERS.has(item.payload.type)
}

/**
 * Assembles one closed turn from work that is already grouped.
 *
 * Shared by both folds so they produce identical turns rather than merely
 * similar ones — and takes items rather than raw events so the incremental
 * fold can group as it goes instead of regrouping the whole turn per frame.
 */
export function assembleTurn(
  prompt: AgentEvent | null,
  items: readonly WorkItem[],
  toolCalls: number,
  completed: AgentEvent | null,
  lastText: string | null,
  index: number,
): Turn {
  const final =
    completed !== null && completed.payload.type === "turn_completed" && completed.payload.finalText !== null
      ? completed.payload.finalText
      : lastText

  // `finalText` repeats the turn's *last* message verbatim, so that one row is
  // dropped rather than printed twice. Only the last: an agent that says
  // "Done." mid-turn and again at the end has said two things, and removing
  // every row whose text matches would silently delete the first.
  let body = items
  if (final !== null) {
    const duplicate = lastIndex(items, (item) => isSameText(item, final))
    if (duplicate !== -1) body = [...items.slice(0, duplicate), ...items.slice(duplicate + 1)]
  }

  return {
    // Keyed on the first thing in the turn, which is stable from the turn's
    // first render: keying on `completed` would remount the whole turn — losing
    // scroll and focus — at the moment it finishes.
    key: `turn:${prompt?.id ?? firstId(items) ?? completed?.id ?? index}`,
    prompt,
    work: body,
    completed,
    finalText: final,
    toolCalls,
    usage: completed !== null && completed.payload.type === "turn_completed" ? completed.payload.usage : null,
  }
}

function isSameText(item: WorkItem, text: string): boolean {
  return !isToolGroup(item) && item.payload.type === "assistant_text" && item.payload.text.trim() === text.trim()
}

function lastIndex(items: readonly WorkItem[], match: (item: WorkItem) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) if (match(items[index]!)) return index
  return -1
}

function firstId(items: readonly WorkItem[]): string | null {
  const first = items[0]
  if (first === undefined) return null
  return isToolGroup(first) ? first.key : first.id
}

/** Collapses one run of consecutive same-tool calls into a group, or leaves it as rows if it is too short. */
export function collapseRun(run: readonly AgentEvent[]): readonly WorkItem[] {
  if (run.length < GROUP_MIN) return run
  const targets = new Set(run.map(titleOf).filter((title): title is string => title !== null))
  const first = run[0]!
  return [
    {
      kind: "tool_group",
      name: first.payload.type === "tool_call_started" ? first.payload.name : "",
      calls: run,
      targets: targets.size === 0 ? run.length : targets.size,
      target: targets.size === 1 ? [...targets][0]! : null,
      key: `group:${first.id}`,
    },
  ]
}

function titleOf(event: AgentEvent): string | null {
  return event.payload.type === "tool_call_started" ? event.payload.title : null
}

/** Collapses runs of consecutive same-tool calls, breaking on any other rendered row. */
export function groupTools(work: readonly AgentEvent[]): readonly WorkItem[] {
  const items: WorkItem[] = []
  let run: AgentEvent[] = []

  const flush = () => {
    if (run.length === 0) return
    items.push(...collapseRun(run))
    run = []
  }

  for (const event of work) {
    if (event.payload.type === "tool_call_started") {
      const name = event.payload.name
      const openName = run[0]?.payload.type === "tool_call_started" ? run[0].payload.name : null
      if (openName !== null && openName !== name) flush()
      run.push(event)
      continue
    }
    // Only a row the reader can see breaks a run. An invisible event between
    // two identical calls would otherwise split the group for no visible cause.
    if (rendersRow(event)) flush()
    items.push(event)
  }
  flush()
  return items
}

/**
 * Folds a whole log in one pass.
 *
 * Implemented *as* the incremental fold rather than beside it. Two
 * implementations of the same rules, kept in agreement by tests, drift the
 * first time someone patches one — and the divergence shows up as a live
 * session disagreeing with the same session reloaded, which is the hardest
 * class of bug to see. The only thing this adds is tolerance for a log that
 * arrives out of order, which a persisted log merged from several sources can.
 */
export function buildTranscript(
  source: readonly AgentEvent[],
  options: {
    readonly live?: boolean
    readonly liveTaskIds?: ReadonlySet<string>
    /**
     * Fold only this session. Required on a transport whose stream is a bus —
     * see [`TranscriptBuilder`] — and unnecessary everywhere else.
     */
    readonly sessionId?: string
  } = {},
): Transcript {
  const builder = new TranscriptBuilder({ sessionId: options.sessionId })
  builder.push(inSeqOrder(source))
  return builder.snapshot(options)
}

/** Live preview text accumulated from deltas, keyed by block. */
export type DeltaBuffers = ReadonlyMap<string, string>

function blockKey(block: BlockRef): string {
  return `${block.messageId}#${block.index}`
}

/**
 * Accumulates delta previews.
 *
 * Deltas are a preview and the committed event supersedes them, so a consumer
 * reads a buffer only while no committed event exists for that block. Absent
 * deltas are ordinary — a delegated run streams none — so a view built on this
 * must render correctly with an empty map.
 *
 * Pass `into` with only the newly arrived events to accumulate incrementally: a
 * live session appends, and rescanning the whole log per frame to rebuild
 * strings that only ever grow is the difference between linear and quadratic
 * over a session's life. Omit it for a one-shot read of a persisted log.
 */
export function applyDeltas(
  events: readonly AgentEvent[],
  into?: Map<string, string>,
): DeltaBuffers {
  const buffers = into ?? new Map<string, string>()
  for (const event of events) {
    const payload = event.payload
    if (payload.type !== "delta") continue
    if (payload.delta === "text") {
      buffers.set(blockKey(payload.block), (buffers.get(blockKey(payload.block)) ?? "") + payload.text)
    }
    if (payload.delta === "input") {
      buffers.set(blockKey(payload.block), (buffers.get(blockKey(payload.block)) ?? "") + payload.partialJson)
    }
  }
  return buffers
}

/** Reads one block's preview, if any has accumulated. */
export function previewOf(buffers: DeltaBuffers, block: BlockRef | null): string | null {
  return block === null ? null : (buffers.get(blockKey(block)) ?? null)
}

/** A stable React key for a run. */
export function runKey(run: DelegatedRun): string {
  return `run:${pathKey(run.path)}`
}

/**
 * Whether the agent is compacting its context *right now*.
 *
 * The boundary event only lands once the summary has been written, which took
 * 17 to 41 seconds across the captures — far too long for a surface to sit
 * looking idle. The status line says `compacting` as the work starts, so this
 * is read from the stream rather than guessed at, and any later status (or the
 * boundary itself) retires it.
 *
 * Derived here rather than in each consumer: "is it busy" is a question about
 * the stream, and two surfaces answering it differently would disagree about
 * the same session.
 */
export function isCompacting(events: readonly AgentEvent[]): boolean {
  let compacting = false
  for (const event of events) {
    if (event.payload.type === "context_compacted") compacting = false
    else if (event.payload.type === "status_changed") compacting = event.payload.status === "compacting"
  }
  return compacting
}
