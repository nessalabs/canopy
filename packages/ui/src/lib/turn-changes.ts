/**
 * Which files each turn made the agent write, from the folded transcript. Pure: a turn's tool calls
 * name their write targets (`filesByCall`, computed daemon-side) and its `file_edits` carry paths;
 * this groups them under the turn, and under the checkout they landed in.
 *
 * A session is listed under the worktree it was started in, but what it writes need not be there:
 * a Claude Code session run from the main checkout that does its work in a worktree of its own
 * puts every file outside the checkout on screen. Attributing by checkout rather than by the one
 * on screen is what keeps such a turn's diff readable.
 */
import type { AgentEdit } from '@canopy/shared'
import type { AgentEvent, Turn } from '@canopy/shared/agent-stream'
import { AgentEventType, isEvent, isToolGroup } from '@canopy/shared/agent-stream'

/** `latest` follows the newest turn that wrote anything; a key pins one turn. */
export type TurnPick = 'latest' | string

/** A checkout a turn's writes can be read against: Canopy's id for it and where it is. */
export interface Checkout {
  id: string
  path: string
}

/** `abs` as a worktree-relative path, or undefined when it lies outside `root`. */
export function relativeTo(root: string, abs: string): string | undefined {
  const prefix = root.endsWith('/') ? root : `${root}/`
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : undefined
}

/** The checkout `abs` lies in — the deepest one, since a worktree may sit inside another. */
export function checkoutOf(checkouts: readonly Checkout[], abs: string): Checkout | undefined {
  let best: Checkout | undefined
  for (const checkout of checkouts) {
    if (relativeTo(checkout.path, abs) === undefined) continue
    if (!best || checkout.path.length > best.path.length) best = checkout
  }
  return best
}

/** The tool-call events in a turn, expanding collapsed same-tool groups back to their calls. */
function callsOf(turn: Turn): AgentEvent[] {
  return turn.work.flatMap((item) => (isToolGroup(item) ? [...item.calls] : [item]))
}

/** Files written per checkout, relative to it; `string[]` insertion order is the write order. */
export type FilesByCheckout = ReadonlyMap<string, string[]>

/**
 * Files written per turn, keyed by the turn's key, then by the checkout they lie in; only turns
 * that wrote something inside one of `checkouts`. A path that is already relative (Codex's
 * `file_edits`) belongs to the first checkout — the one the session runs in.
 */
export function filesByTurn(turns: readonly Turn[], filesByCall: Record<string, string[]>, checkouts: readonly Checkout[]): ReadonlyMap<string, FilesByCheckout> {
  const result = new Map<string, FilesByCheckout>()
  const home = checkouts[0]
  for (const turn of turns) {
    const files = new Map<string, Set<string>>()
    const add = (path: string): void => {
      const checkout = path.startsWith('/') ? checkoutOf(checkouts, path) : home
      if (!checkout) return
      const relative = path.startsWith('/') ? relativeTo(checkout.path, path) : path
      if (!relative) return
      const set = files.get(checkout.id) ?? new Set<string>()
      set.add(relative)
      files.set(checkout.id, set)
    }
    for (const event of callsOf(turn)) {
      if (isEvent(event, AgentEventType.ToolCallStarted)) {
        for (const abs of filesByCall[event.payload.callId] ?? []) add(abs)
      }
      if (isEvent(event, AgentEventType.FileEdits)) {
        for (const edit of event.payload.edits) add(edit.path)
      }
    }
    if (files.size > 0) result.set(turn.key, new Map([...files].map(([id, set]) => [id, [...set].sort()])))
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

/**
 * Folds snapshot edits into turns by joining `toolUseId` (= `callId`) to the tool call and its
 * turn, one snapshot per checkout the turn wrote in: a tree is of one checkout, so writes in two
 * are two snapshots, never one with mixed trees.
 */
export function snapshotsByTurn(turns: readonly Turn[], edits: AgentEdit[]): ReadonlyMap<string, ReadonlyMap<string, TurnSnapshot>> {
  const turnOfCall = new Map<string, string>()
  for (const turn of turns) {
    for (const event of callsOf(turn)) {
      if (isEvent(event, AgentEventType.ToolCallStarted)) turnOfCall.set(event.payload.callId, turn.key)
    }
  }
  const result = new Map<string, Map<string, TurnSnapshot>>()
  for (const edit of edits) {
    const key = turnOfCall.get(edit.toolUseId)
    if (!key) continue
    const byCheckout = result.get(key) ?? new Map<string, TurnSnapshot>()
    const current = byCheckout.get(edit.worktreeId) ?? { before: edit.beforeTree, after: edit.afterTree, files: [], unattributed: [] }
    current.after = edit.afterTree
    if (!current.files.includes(edit.path)) current.files.push(edit.path)
    if (!edit.attributed && !current.unattributed.includes(edit.path)) current.unattributed.push(edit.path)
    byCheckout.set(edit.worktreeId, current)
    result.set(key, byCheckout)
  }
  for (const byCheckout of result.values()) for (const snapshot of byCheckout.values()) snapshot.files.sort()
  return result
}

/** What is known about a turn's changes: the exact snapshot when hooks recorded one, else the named files. */
export interface TurnEntry {
  /** The checkout the diff is read against: where most of the turn's writes landed. */
  worktreeId: string
  /** Paths relative to that checkout. */
  files: string[]
  snapshot?: TurnSnapshot
  /** Files the turn wrote in other checkouts, which this entry's diff does not show. */
  elsewhere: number
}

/**
 * Snapshots win; transcript-named files fill in for a checkout without one. Turn order is kept.
 * A turn that wrote in more than one checkout is read against the one it wrote most in, ties
 * going to `preferred` (the checkout on screen) and then to the order the writes were seen.
 */
export function mergeTurns(named: ReadonlyMap<string, FilesByCheckout>, snapshots: ReadonlyMap<string, ReadonlyMap<string, TurnSnapshot>>, preferred?: string): ReadonlyMap<string, TurnEntry> {
  const merged = new Map<string, TurnEntry>()
  for (const key of new Set([...named.keys(), ...snapshots.keys()])) {
    const byCheckout = new Map<string, { files: string[]; snapshot?: TurnSnapshot }>()
    for (const [id, files] of named.get(key) ?? []) byCheckout.set(id, { files })
    for (const [id, snapshot] of snapshots.get(key) ?? []) byCheckout.set(id, { files: snapshot.files, snapshot })
    let best: [string, { files: string[]; snapshot?: TurnSnapshot }] | undefined
    for (const candidate of byCheckout) {
      if (!best) best = candidate
      else if (candidate[1].files.length > best[1].files.length) best = candidate
      else if (candidate[1].files.length === best[1].files.length && candidate[0] === preferred) best = candidate
    }
    if (!best) continue
    const [worktreeId, entry] = best
    let elsewhere = 0
    for (const [id, other] of byCheckout) if (id !== worktreeId) elsewhere += other.files.length
    merged.set(key, { worktreeId, files: entry.files, ...(entry.snapshot ? { snapshot: entry.snapshot } : {}), elsewhere })
  }
  return merged
}
