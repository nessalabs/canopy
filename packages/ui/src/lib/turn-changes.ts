/**
 * Which files each user turn made the agent write. Pure: the transcript already carries
 * `files` on tool items; this groups them under the user message that started the turn.
 */
import type { AgentEdit, TranscriptItem } from '@canopy/shared'

/** `latest` follows the newest turn that wrote anything; an id pins one turn. */
export type TurnPick = 'latest' | string

/** `abs` as a worktree-relative path, or undefined when it lies outside `root`. */
export function relativeTo(root: string, abs: string): string | undefined {
  const prefix = root.endsWith('/') ? root : `${root}/`
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : undefined
}

/** Files written per turn, keyed by the user item's id; only turns that wrote something inside `root`. */
export function filesByTurn(items: TranscriptItem[], root: string): ReadonlyMap<string, string[]> {
  const turns = new Map<string, Set<string>>()
  let current: Set<string> | undefined
  for (const item of items) {
    if (item.role === 'user') {
      current = new Set()
      turns.set(item.id, current)
      continue
    }
    for (const file of item.files ?? []) {
      const path = relativeTo(root, file)
      if (path) current?.add(path)
    }
  }
  return new Map([...turns].filter(([, files]) => files.size > 0).map(([id, files]) => [id, [...files].sort()]))
}

/** The turn a pick names: the last one with changes for `latest`, else the pinned id (undefined once it is gone). */
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

/** Folds snapshot edits into turns by joining `toolUseId` to the tool item and that item to its user turn. */
export function snapshotsByTurn(items: TranscriptItem[], edits: AgentEdit[]): ReadonlyMap<string, TurnSnapshot> {
  const turnOfTool = new Map<string, string>()
  let turn: string | undefined
  for (const item of items) {
    if (item.role === 'user') turn = item.id
    else if (item.toolUseId && turn) turnOfTool.set(item.toolUseId, turn)
  }
  const result = new Map<string, TurnSnapshot>()
  for (const edit of edits) {
    const id = turnOfTool.get(edit.toolUseId)
    if (!id) continue
    const current = result.get(id) ?? { before: edit.beforeTree, after: edit.afterTree, files: [], unattributed: [] }
    current.after = edit.afterTree
    if (!current.files.includes(edit.path)) current.files.push(edit.path)
    if (!edit.attributed && !current.unattributed.includes(edit.path)) current.unattributed.push(edit.path)
    result.set(id, current)
  }
  for (const snapshot of result.values()) snapshot.files.sort()
  return result
}

/** What is known about a turn's changes: the exact snapshot when hooks recorded one, else the files the transcript named. */
export interface TurnEntry {
  files: string[]
  snapshot?: TurnSnapshot
}

/** Snapshots win; transcript-named files fill in for turns without one. Transcript order is kept. */
export function mergeTurns(named: ReadonlyMap<string, string[]>, snapshots: ReadonlyMap<string, TurnSnapshot>): ReadonlyMap<string, TurnEntry> {
  const merged = new Map<string, TurnEntry>()
  for (const [id, files] of named) merged.set(id, { files })
  for (const [id, snapshot] of snapshots) merged.set(id, { files: snapshot.files, snapshot })
  return merged
}
