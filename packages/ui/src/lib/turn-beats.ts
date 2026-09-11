import type { AgentEvent, DelegatedRun, JsonValue, ToolKind, ToolResult, Transcript, WorkItem } from '@canopy/shared/agent-stream'
import { AgentEventType, isEvent, isToolGroup } from '@canopy/shared/agent-stream'

/** What one collapsed run of tool work looks like from the outside. */
export type BeatStatus = 'running' | 'complete' | 'error'

/** One tool call inside a beat, with its outcome already looked up. */
export interface BeatCall {
  readonly event: AgentEvent
  readonly callId: string
  readonly name: string
  readonly kind: ToolKind
  readonly title: string
  readonly input: JsonValue
  readonly result: ToolResult | undefined
  /** The turn ended (or the thread moved on) before this call ever got a result. */
  readonly abandoned: boolean
  readonly status: BeatStatus
  /** The delegated run this call spawned, for a subagent or workflow call. */
  readonly run: DelegatedRun | null
}

/** How many of each kind of thing a beat did — the numbers an activity cue is written from. */
export interface BeatCounts {
  /** Distinct files read or edited. */
  readonly files: number
  readonly searches: number
  /** Shell commands. */
  readonly commands: number
  /** Everything else the agent ran itself (web, MCP, …); delegated runs are not counted. */
  readonly other: number
}

/**
 * A stretch of the agent working between two things it said: its thinking and the tools it ran,
 * collapsed behind one line. Delegated runs (`runs`) are drawn as their own cards beside the cue.
 */
export interface ActivityBeat {
  readonly kind: 'activity'
  readonly key: string
  readonly thoughts: readonly AgentEvent[]
  readonly calls: readonly BeatCall[]
  readonly runs: readonly BeatCall[]
  /** Hooks that fired in this stretch — one row per run: the finish where there is one, else the start. */
  readonly hooks: readonly AgentEvent[]
  readonly counts: BeatCounts
  readonly status: BeatStatus
  /** Calls that returned an error. The cue stays quiet about them; the sheet shows which. */
  readonly failed: number
}

export type Beat =
  | ActivityBeat
  | { readonly kind: 'text'; readonly key: string; readonly event: AgentEvent }
  | { readonly kind: 'user'; readonly key: string; readonly event: AgentEvent }
  | { readonly kind: 'note'; readonly key: string; readonly event: AgentEvent; readonly tone: 'error' | 'muted'; readonly text: string }
  | { readonly kind: 'compacted'; readonly key: string; readonly event: AgentEvent }

const isDelegating = (kind: ToolKind): boolean => kind === 'subagent' || kind === 'workflow'

function callOf(event: AgentEvent, transcript: Transcript): BeatCall | null {
  if (!isEvent(event, AgentEventType.ToolCallStarted)) return null
  const { callId, name, kind, input, title } = event.payload
  const result = transcript.resultByCallId.get(callId)
  const abandoned = transcript.abandonedCallIds.has(callId)
  const status: BeatStatus = result === undefined ? (abandoned ? 'error' : 'running') : result.isError ? 'error' : 'complete'
  return { event, callId, name, kind, title, input, result, abandoned, status, run: transcript.runByCallId.get(callId) ?? null }
}

function countsOf(calls: readonly BeatCall[]): BeatCounts {
  const files = new Set<string>()
  let searches = 0
  let commands = 0
  let other = 0
  for (const call of calls) {
    if (call.kind === 'file_read' || call.kind === 'file_edit') files.add(call.title || call.callId)
    else if (call.kind === 'search') searches += 1
    else if (call.kind === 'shell') commands += 1
    else other += 1
  }
  return { files: files.size, searches, commands, other }
}

/**
 * One row per hook run: a `finished` event replaces the `started` it closes, so a hook that ran
 * once is counted once and the row carries its outcome. A start still waiting keeps its own row.
 */
function pairHooks(events: readonly AgentEvent[]): AgentEvent[] {
  const open = new Map<string, AgentEvent[]>()
  const rows: AgentEvent[] = []
  for (const event of events) {
    if (!isEvent(event, AgentEventType.Hook)) continue
    const key = `${event.payload.name}|${event.payload.event}`
    const waiting = open.get(key) ?? []
    if (event.payload.phase === 'started') {
      waiting.push(event)
      open.set(key, waiting)
      rows.push(event)
      continue
    }
    const started = waiting.pop()
    open.set(key, waiting)
    const at = started ? rows.indexOf(started) : -1
    if (at === -1) rows.push(event)
    else rows[at] = event
  }
  return rows
}

/** Closes a beat in progress, or nothing when it never collected anything. */
function finish(key: string, thoughts: AgentEvent[], all: BeatCall[], hooks: AgentEvent[]): ActivityBeat | null {
  if (thoughts.length === 0 && all.length === 0 && hooks.length === 0) return null
  const runs = all.filter((call) => call.run !== null || isDelegating(call.kind))
  const calls = all.filter((call) => !runs.includes(call))
  const running = all.some((call) => call.status === 'running' || (call.run !== null && !call.run.done))
  return {
    kind: 'activity',
    key,
    thoughts,
    calls,
    runs,
    hooks: pairHooks(hooks),
    counts: countsOf(calls),
    status: running ? 'running' : 'complete',
    failed: calls.filter((call) => call.status === 'error').length
  }
}

/**
 * Folds a turn's rows into beats: every message the agent (or the user) wrote stays a message, and
 * everything the agent did *between* messages — thinking, tool calls, the runs it delegated —
 * collapses into one activity beat. The transcript reads as a conversation; the work is one line
 * per stretch, opened on demand.
 */
export function beatsOf(rows: readonly WorkItem[], transcript: Transcript): readonly Beat[] {
  const beats: Beat[] = []
  let thoughts: AgentEvent[] = []
  let calls: BeatCall[] = []
  let hooks: AgentEvent[] = []
  let key: string | null = null

  const close = (): void => {
    const beat = key === null ? null : finish(key, thoughts, calls, hooks)
    if (beat) beats.push(beat)
    thoughts = []
    calls = []
    hooks = []
    key = null
  }
  const collect = (event: AgentEvent): void => {
    key ??= `beat:${event.id}`
    if (isEvent(event, AgentEventType.Reasoning)) {
      if (event.payload.text.trim() !== '') thoughts.push(event)
      return
    }
    // A hook is the harness acting, not the agent: it belongs in the count and the sheet, never
    // as a row of its own in the conversation.
    if (isEvent(event, AgentEventType.Hook)) {
      hooks.push(event)
      return
    }
    const call = callOf(event, transcript)
    if (call) calls.push(call)
  }

  for (const item of rows) {
    if (isToolGroup(item)) {
      for (const call of item.calls) collect(call)
      continue
    }
    if (isEvent(item, AgentEventType.Reasoning) || isEvent(item, AgentEventType.ToolCallStarted) || isEvent(item, AgentEventType.Hook)) {
      collect(item)
      continue
    }
    // Rows the fold draws elsewhere or that only echo a call already collected.
    if (isEvent(item, AgentEventType.TaskStarted)) continue
    if (isEvent(item, AgentEventType.AssistantText)) {
      if (item.payload.text.trim() === '' && item.payload.block === null) continue
      close()
      beats.push({ kind: 'text', key: item.id, event: item })
      continue
    }
    if (isEvent(item, AgentEventType.UserMessage)) {
      if (item.payload.synthetic) continue
      close()
      beats.push({ kind: 'user', key: item.id, event: item })
      continue
    }
    if (isEvent(item, AgentEventType.ContextCompacted)) {
      close()
      beats.push({ kind: 'compacted', key: item.id, event: item })
      continue
    }
    if (isEvent(item, AgentEventType.Error)) {
      close()
      // Stopping the agent is something the person did, not something that went wrong.
      const stopped = item.payload.message.startsWith('[Request interrupted by user')
      beats.push({ kind: 'note', key: item.id, event: item, tone: stopped ? 'muted' : 'error', text: stopped ? 'Stopped by you' : item.payload.message })
      continue
    }
    if (isEvent(item, AgentEventType.PermissionDenied)) {
      close()
      beats.push({ kind: 'note', key: item.id, event: item, tone: 'muted', text: `${item.payload.toolName} was not allowed: ${item.payload.message}` })
      continue
    }
    if (isEvent(item, AgentEventType.RateLimited)) {
      close()
      beats.push({ kind: 'note', key: item.id, event: item, tone: 'muted', text: `Rate limited (${item.payload.status})` })
    }
  }
  close()
  return beats
}

/** "3 files, 2 searches, 4 commands" — the counted part of an activity label, or '' for none. */
export function describeCounts(counts: BeatCounts): string {
  const bits: string[] = []
  if (counts.files) bits.push(`${counts.files} file${counts.files === 1 ? '' : 's'}`)
  if (counts.searches) bits.push(`${counts.searches} search${counts.searches === 1 ? '' : 'es'}`)
  if (counts.commands) bits.push(`${counts.commands} command${counts.commands === 1 ? '' : 's'}`)
  if (counts.other) bits.push(`${counts.other} other tool${counts.other === 1 ? '' : 's'}`)
  return bits.join(', ')
}

/**
 * The one line a beat gets in the transcript. A beat with nothing but thinking behind it reads as a
 * thought; one that only ran commands says so, since "explored 4 commands" is nobody's sentence;
 * one still running reads in the present tense so the shimmer has something to say.
 */
export function beatLabel(beat: ActivityBeat): string {
  const hooks = beat.hooks.length
  const hookBit = hooks === 0 ? '' : `${hooks} hook${hooks === 1 ? '' : 's'}`
  if (beat.calls.length === 0) {
    if (hookBit) return beat.status === 'running' ? `Running ${hookBit}…` : `Ran ${hookBit}`
    return beat.thoughts.length > 0 ? 'Thought for a moment' : 'Delegated'
  }
  const detail = [describeCounts(beat.counts), hookBit].filter(Boolean).join(', ')
  const { files, searches, other } = beat.counts
  const onlyCommands = files === 0 && searches === 0 && other === 0 && hooks === 0
  if (beat.status === 'running') return onlyCommands ? `Running ${detail}…` : detail ? `Exploring ${detail}…` : 'Exploring…'
  return onlyCommands ? `Ran ${detail}` : detail ? `Explored ${detail}` : 'Explored'
}
