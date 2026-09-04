/**
 * Which files each turn made the agent write, from the folded transcript. Pure: a turn's tool calls
 * name their write targets (`filesByCall`, computed daemon-side) and its `file_edits` carry paths;
 * this groups them under the turn.
 */
import type { AgentEdit } from '@canopy/shared'
import type { AgentEvent, Turn } from '@canopy/shared/agent-stream'
import { AgentEventType, isEvent, isToolGroup } from '@canopy/shared/agent-stream'

/** `latest` follows the newest turn that wrote anything; a key pins one turn. */
export type TurnPick = 'latest' | string

/** `abs` as a worktree-relative path, or undefined when it lies outside `root`. */
export function relativeTo(root: string, abs: string): string | undefined {
  const prefix = root.endsWith('/') ? root : `${root}/`
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : undefined
}

/** The tool-call events in a turn, expanding collapsed same-tool groups back to their calls. */
function callsOf(turn: Turn): AgentEvent[] {
  return turn.work.flatMap((item) => (isToolGroup(item) ? [...item.calls] : [item]))
}

/** A path relative to `root`: sliced when it is inside `root`, kept as-is when already relative. */
function within(root: string, path: string): string | undefined {
  if (path.startsWith('/')) return relativeTo(root, path)
  return path
}

/** Files written per turn, keyed by the turn's key; only turns that wrote something inside `root`. */
export function filesByTurn(turns: readonly Turn[], filesByCall: Record<string, string[]>, root: string): ReadonlyMap<string, string[]> {
  const result = new Map<string, string[]>()
  for (const turn of turns) {
    const files = new Set<string>()
    for (const event of callsOf(turn)) {
      if (isEvent(event, AgentEventType.ToolCallStarted)) {
        for (const abs of filesByCall[event.payload.callId] ?? []) {
          const path = relativeTo(root, abs)
          if (path) files.add(path)
        }
      }
      if (isEvent(event, AgentEventType.FileEdits)) {
        for (const edit of event.payload.edits) {
          const path = within(root, edit.path)
          if (path) files.add(path)
        }
      }
    }
    if (files.size > 0) result.set(turn.key, [...files].sort())
  }
  return result
}

/** The turn a pick names: the last one with changes for `latest`, else the pinned key (undefined once gone). */
export function resolveTurn(pick: TurnPick | undefined, byTurn: ReadonlyMap<string, unknown>): string | undefined {
  if (pick === undefined) return undefined
  if (pick === 'latest') return [...byTurn.keys()].at(-1)
  return byTurn.has(pick) ? pick : undefined
}

/** A turn's exact change set from hook snapshots: the tree before its first write and after its last. */
export interface TurnSnapshot {
  before: string
  after: string
  files: string[]
  /** Files changed during the turn that none of its tool calls named — likely another agent's. */
  unattributed: string[]
}

/** Folds snapshot edits into turns by joining `toolUseId` (= `callId`) to the tool call and its turn. */
export function snapshotsByTurn(turns: readonly Turn[], edits: AgentEdit[]): ReadonlyMap<string, TurnSnapshot> {
  const turnOfCall = new Map<string, string>()
  for (const turn of turns) {
    for (const event of callsOf(turn)) {
      if (isEvent(event, AgentEventType.ToolCallStarted)) turnOfCall.set(event.payload.callId, turn.key)
    }
  }
  const result = new Map<string, TurnSnapshot>()
  for (const edit of edits) {
    const key = turnOfCall.get(edit.toolUseId)
    if (!key) continue
    const current = result.get(key) ?? { before: edit.beforeTree, after: edit.afterTree, files: [], unattributed: [] }
    current.after = edit.afterTree
    if (!current.files.includes(edit.path)) current.files.push(edit.path)
    if (!edit.attributed && !current.unattributed.includes(edit.path)) current.unattributed.push(edit.path)
    result.set(key, current)
  }
  for (const snapshot of result.values()) snapshot.files.sort()
  return result
}

/** What is known about a turn's changes: the exact snapshot when hooks recorded one, else the named files. */
export interface TurnEntry {
  files: string[]
  snapshot?: TurnSnapshot
}

/** Snapshots win; transcript-named files fill in for turns without one. Turn order is kept. */
export function mergeTurns(named: ReadonlyMap<string, string[]>, snapshots: ReadonlyMap<string, TurnSnapshot>): ReadonlyMap<string, TurnEntry> {
  const merged = new Map<string, TurnEntry>()
  for (const [key, files] of named) merged.set(key, { files })
  for (const [key, snapshot] of snapshots) merged.set(key, { files: snapshot.files, snapshot })
  return merged
}
