/** @responsibility Folds a live event log incrementally, so a running session costs work proportional to what arrived rather than to its whole length. */

import type { AgentEvent, AgentPath, PlanStep, SessionInfo, ToolResult, Usage } from "../events"
import { pathKey } from "../events"
import type { DelegatedRun, Transcript, Turn, WorkItem } from "./fold"
import { assembleTurn, collapseRun, rendersRow } from "./fold"

const EMPTY_TASKS: ReadonlySet<string> = new Set()

interface MutableRun {
  callId: string
  taskId: string | null
  kind: DelegatedRun["kind"]
  label: string | null
  description: string | null
  transcriptId: string | null
  status: string | null
  lastTool: string | null
  done: boolean
  usage: Usage | null
  events: AgentEvent[]
  plan: readonly PlanStep[]
  phases: DelegatedRun["phases"]
  depth: number
  path: AgentPath
}

/**
 * Builds a transcript as events arrive.
 *
 * The one-shot [`buildTranscript`] re-reads the whole log, which is right for a
 * persisted session and quadratic for a live one: a fold per event over a log
 * that grows per event. This holds the accumulation instead, so a new event
 * costs the work that event implies, and closed turns — which can never change
 * — are assembled once and kept.
 *
 * The two agree exactly; the test suite asserts it against every fixture.
 */
export class TranscriptBuilder {
  private readonly events: AgentEvent[] = []
  private readonly mainEvents: AgentEvent[] = []
  private readonly resultByCallId = new Map<string, ToolResult>()
  private readonly open = new Set<string>()
  /** Which thread each open call belongs to, so a prompt only abandons its own. */
  private readonly pathOfCall = new Map<string, AgentPath>()
  private readonly abandoned = new Set<string>()
  private readonly asks = new Map<string, AgentEvent>()
  private readonly runs = new Map<string, MutableRun>()
  private readonly sessions: SessionInfo[] = []
  private plan: readonly PlanStep[] = []
  private usage: Usage | null = null

  /** Turns that have closed. A closed turn is final, so it is assembled once. */
  private readonly closedTurns: Turn[] = []
  private prompt: AgentEvent | null = null
  /**
   * The open turn's work, already grouped.
   *
   * Grouping incrementally rather than at snapshot time is what keeps a
   * snapshot proportional to what arrived: re-running `groupTools` over the
   * whole open turn on every frame is quadratic *within* a turn, and an
   * autonomous turn with hundreds of tool calls is the normal case.
   */
  private openItems: WorkItem[] = []
  /** The trailing run of same-tool calls, not yet decided to be a group. */
  private openRun: AgentEvent[] = []
  private openToolCalls = 0
  private lastText: string | null = null
  private highestSeq = -1
  private lowestSeq = Number.POSITIVE_INFINITY
  /** Bumped on every absorbed event, so a consumer can memoize on a value that actually changes. */
  private revision = 0
  /**
   * The one session this fold is for, when a stream carries several.
   *
   * A transcript is one conversation. Most wires give exactly that, but
   * opencode's server bus publishes every session on the machine — including
   * a subagent's own — onto one connection, and folding those together merges
   * two conversations' turns, plans and asks into one. Naming the session is
   * how a consumer reads the one it is showing; leaving it unset folds
   * whatever arrives, which is right for every one-session wire.
   */
  private readonly only: string | null

  constructor(options: { readonly sessionId?: string } = {}) {
    this.only = options.sessionId ?? null
  }

  /** Feeds newly mapped events in arrival order. */
  push(incoming: readonly AgentEvent[]): void {
    for (const event of incoming) {
      if (this.only !== null && event.sessionId !== this.only) continue
      // A re-delivered event is the ordinary shape of a reconnect: any
      // at-least-once transport replays its last chunk. Since `seq` is dense
      // per session, anything inside the range already absorbed is a replay and
      // is skipped — idempotent, so a resumed tail costs nothing.
      if (event.seq <= this.highestSeq && event.seq >= this.lowestSeq) continue

      // Arriving *before* everything seen is different: it would land in
      // whichever turn happens to be open, silently misfiling it. That is worth
      // refusing, and a caller holding a shuffled log has `buildTranscript`.
      if (event.seq <= this.highestSeq) {
        throw new Error(
          `TranscriptBuilder received seq ${event.seq} after ${this.highestSeq}; feed events in order or use buildTranscript`,
        )
      }

      this.highestSeq = event.seq
      if (event.seq < this.lowestSeq) this.lowestSeq = event.seq
      this.revision += 1
      this.events.push(event)
      this.absorb(event)
    }
  }

  private absorb(event: AgentEvent): void {
    const payload = event.payload

    switch (payload.type) {
      case "tool_call_started":
        this.open.add(payload.callId)
        this.pathOfCall.set(payload.callId, event.agentPath)
        break
      case "tool_call_completed":
        this.open.delete(payload.callId)
        // A result un-abandons its call. A prompt typed while the call was in
        // flight marks it abandoned; if the result then arrives, the row is
        // both "will never finish" and holding an answer, and whichever the
        // view checks first wins.
        this.abandoned.delete(payload.callId)
        this.resultByCallId.set(payload.callId, payload.result)
        break
      case "user_message":
        // A new prompt closes the book on the thread it was typed into — and
        // only that thread. A main-thread prompt says nothing about what a
        // subagent is in the middle of.
        if (!payload.synthetic) this.abandonOpenCalls(event.agentPath)
        break
      case "plan_updated":
        // A delegated run keeps its own plan. Without the guard a subagent's
        // checklist silently replaces the main agent's.
        if (event.agentPath.length === 0) this.plan = payload.steps
        else this.runFor(event.agentPath[event.agentPath.length - 1]!, event.agentPath, event.agentPath.length).plan = payload.steps
        break
      case "session_started":
        this.sessions.push(payload.session)
        break
      case "turn_completed":
        // A delegated run's own result must not overwrite the session's totals.
        if (payload.usage !== null && event.agentPath.length === 0) this.usage = payload.usage
        break
      case "permission_requested":
        this.asks.set(payload.requestId, event)
        break
      case "permission_decided":
        this.asks.delete(payload.requestId)
        break
      default:
        break
    }

    this.absorbRun(event)
    if (event.agentPath.length === 0) this.absorbMain(event)
  }

  /** Marks every call still open on one thread as abandoned, leaving other threads alone. */
  private abandonOpenCalls(path: AgentPath): void {
    const scope = pathKey(path)
    for (const callId of this.open) {
      if (pathKey(this.pathOfCall.get(callId) ?? []) !== scope) continue
      this.abandoned.add(callId)
      this.open.delete(callId)
    }
  }

  private runFor(callId: string, path: AgentPath, depth: number): MutableRun {
    let run = this.runs.get(callId)
    if (run === undefined) {
      run = {
        callId,
        taskId: null,
        kind: "other",
        label: null,
        description: null,
        transcriptId: null,
        status: null,
        lastTool: null,
        done: false,
        usage: null,
        events: [],
        plan: [],
        phases: [],
        depth,
        path,
      }
      this.runs.set(callId, run)
    }
    return run
  }

  private absorbRun(event: AgentEvent): void {
    const payload = event.payload
    const below = event.agentPath.length + 1

    // A nested run's lifecycle is also work its *parent* did, and a
    // `task_started` renders a row — so at depth it must reach the parent's
    // body, not only open a child run.
    if (
      event.agentPath.length > 0 &&
      (payload.type === "task_started" || payload.type === "task_progress" || payload.type === "task_completed")
    ) {
      const parent = event.agentPath[event.agentPath.length - 1]!
      this.runFor(parent, event.agentPath, event.agentPath.length).events.push(event)
    }

    if (payload.type === "task_started") {
      const run = this.runFor(payload.callId, [...event.agentPath, payload.callId], below)
      run.taskId = payload.taskId
      run.kind = payload.taskKind
      run.label = payload.label
      run.description = payload.description
      run.transcriptId = payload.transcriptId
      return
    }
    if (payload.type === "task_progress") {
      const run = this.runFor(payload.callId, [...event.agentPath, payload.callId], below)
      run.taskId = payload.taskId
      run.status = payload.description
      run.lastTool = payload.lastTool
      if (payload.usage !== null) run.usage = payload.usage
      return
    }
    if (payload.type === "workflow_progress") {
      const run = this.runFor(payload.callId, [...event.agentPath, payload.callId], below)
      run.taskId = payload.taskId
      run.phases = payload.phases
      return
    }
    if (payload.type === "task_completed" && payload.callId !== null) {
      const run = this.runFor(payload.callId, [...event.agentPath, payload.callId], below)
      run.taskId = payload.taskId
      run.done = true
      if (payload.usage !== null) run.usage = payload.usage
      return
    }
    if (event.agentPath.length > 0) {
      const callId = event.agentPath[event.agentPath.length - 1]!
      this.runFor(callId, event.agentPath, event.agentPath.length).events.push(event)
    }
  }

  private absorbMain(event: AgentEvent): void {
    this.mainEvents.push(event)
    const payload = event.payload

    if (payload.type === "user_message" && !payload.synthetic) {
      if (this.prompt !== null || this.openItems.length > 0 || this.openRun.length > 0) this.closeTurn(null)
      this.prompt = event
      return
    }
    if (payload.type === "turn_completed") {
      this.closeTurn(event)
      return
    }
    if (payload.type === "assistant_text") this.lastText = payload.text
    this.addWork(event)
  }

  /** Extends the open turn, keeping the trailing same-tool run open until something breaks it. */
  private addWork(event: AgentEvent): void {
    if (event.payload.type === "tool_call_started") {
      this.openToolCalls += 1
      const openName = this.openRun[0]?.payload.type === "tool_call_started" ? this.openRun[0].payload.name : null
      if (openName !== null && openName !== event.payload.name) this.flushRun()
      this.openRun.push(event)
      return
    }
    // Only a row the reader can see breaks a run; an invisible event between
    // two identical calls would otherwise split the group for no visible cause.
    if (rendersRow(event)) this.flushRun()
    this.openItems.push(event)
  }

  private flushRun(): void {
    if (this.openRun.length === 0) return
    this.openItems.push(...collapseRun(this.openRun))
    this.openRun = []
  }

  /** The open turn's items without disturbing the builder's state, for a snapshot. */
  private openWorkItems(): readonly WorkItem[] {
    return this.openRun.length === 0 ? this.openItems : [...this.openItems, ...collapseRun(this.openRun)]
  }

  private closeTurn(completed: AgentEvent | null): void {
    this.flushRun()
    this.closedTurns.push(
      assembleTurn(this.prompt, this.openItems, this.openToolCalls, completed, this.lastText, this.closedTurns.length),
    )
    this.prompt = null
    this.openItems = []
    this.openRun = []
    this.openToolCalls = 0
    this.lastText = null
  }

  /**
   * The transcript as it stands.
   *
   * Only the open turn is assembled here, so a snapshot costs the work in
   * flight rather than the session's whole history. `live` and `liveTaskIds`
   * are read at snapshot time because both describe *now* — whether a process
   * is still running is not a property of any event.
   */
  snapshot(options: { readonly live?: boolean; readonly liveTaskIds?: ReadonlySet<string> } = {}): Transcript {
    const live = options.live ?? false
    const liveTaskIds = options.liveTaskIds ?? EMPTY_TASKS

    const abandoned = new Set(this.abandoned)
    if (!live) for (const callId of this.open) abandoned.add(callId)

    const runByCallId = new Map<string, DelegatedRun>()
    for (const run of this.runs.values()) {
      runByCallId.set(run.callId, {
        ...run,
        // Copied: a run's events array is still being appended to, and a
        // consumer holding a "snapshot" whose contents grow underneath it is
        // the bug an immutable-looking type invites.
        events: [...run.events],
        done: run.done || (!live && !liveTaskIds.has(run.taskId ?? "")),
      })
    }

    const turns = [...this.closedTurns]
    const openItems = this.openWorkItems()
    if (this.prompt !== null || openItems.length > 0) {
      turns.push(assembleTurn(this.prompt, openItems, this.openToolCalls, null, this.lastText, turns.length))
    }

    return {
      revision: this.revision,
      // `events` and `resultByCallId` are the builder's own growing collections
      // rather than copies: copying either per frame would be proportional to
      // the whole session, which is the cost this class exists to avoid. They
      // are append-only and never rewritten, so a consumer memoizes on
      // `revision` — the identity of these deliberately does not change.
      events: this.mainEvents,
      turns,
      runs: [...runByCallId.values()],
      runByCallId,
      resultByCallId: this.resultByCallId,
      abandonedCallIds: abandoned,
      plan: this.plan,
      session: this.sessions.length === 0 ? null : this.sessions[this.sessions.length - 1]!,
      sessions: [...this.sessions],
      pendingAsks: [...this.asks.values()],
      usage: this.usage,
    }
  }
}
