/**
 * The two pieces of arithmetic the commit panel's file list needs, kept pure so they can be
 * tested without a DOM: rolling a folder's checkbox state up from the files beneath it, and
 * turning a shift-click into a range of rows.
 */
import type { StagedState } from '@canopy/shared'

import { type FlatRow, type TreeDir } from './file-tree'

/** A checkbox's three visual states. `mixed` is the folder whose files disagree. */
export type CheckState = 'checked' | 'unchecked' | 'mixed'

export const checkStateOf = (staged: StagedState): CheckState =>
  staged === 'staged' ? 'checked' : staged === 'partial' ? 'mixed' : 'unchecked'

/** Every file path at or below `dir`, in tree order. `''` is the root. */
export function filesUnder(root: TreeDir, dir: string): string[] {
  let node: TreeDir | undefined = root
  for (const name of dir === '' ? [] : dir.split('/')) node = node?.dirs.get(name)
  if (!node) return []
  const paths: string[] = []
  const walk = (current: TreeDir): void => {
    for (const child of current.dirs.values()) walk(child)
    for (const path of current.files.values()) paths.push(path)
  }
  walk(node)
  return paths
}

/**
 * A check state for every directory, from the files below it at any depth.
 *
 * This cannot reuse `dirTotals` from file-tree.ts: that accumulator is fixed to additions,
 * deletions and comments, and borrowing one of those fields to carry a count of staged files
 * would put a wrong number in the row's meta column.
 */
export function dirCheckStates(root: TreeDir, stateOf: (path: string) => CheckState): Map<string, CheckState> {
  const states = new Map<string, CheckState>()
  const walk = (dir: TreeDir): { checked: number; unchecked: number; mixed: number } => {
    const tally = { checked: 0, unchecked: 0, mixed: 0 }
    for (const child of dir.dirs.values()) {
      const below = walk(child)
      tally.checked += below.checked
      tally.unchecked += below.unchecked
      tally.mixed += below.mixed
    }
    for (const path of dir.files.values()) tally[stateOf(path)] += 1
    const total = tally.checked + tally.unchecked + tally.mixed
    states.set(dir.path, tally.mixed > 0 || (tally.checked > 0 && tally.unchecked > 0) ? 'mixed' : tally.checked === total && total > 0 ? 'checked' : 'unchecked')
    return tally
  }
  walk(root)
  return states
}

/** The rows between two ids inclusive, in display order; empty when either is not visible. */
export function rowsBetween(rows: readonly FlatRow[], fromId: string, toId: string): FlatRow[] {
  const from = rows.findIndex((row) => row.id === fromId)
  const to = rows.findIndex((row) => row.id === toId)
  if (from === -1 || to === -1) return []
  return rows.slice(Math.min(from, to), Math.max(from, to) + 1)
}

/**
 * How a click changes the highlighted set — the Finder rules. `anchor` is the row a later
 * shift-click measures from, and it deliberately does not move on a shift-click so that
 * repeated shift-clicks grow and shrink the same range.
 */
export function clickSelection(
  rows: readonly FlatRow[],
  current: ReadonlySet<string>,
  anchor: string | undefined,
  id: string,
  modifiers: { shift: boolean; meta: boolean }
): { selected: Set<string>; anchor: string } {
  if (modifiers.shift && anchor !== undefined) {
    const range = rowsBetween(rows, anchor, id).map((row) => row.id)
    // Additive with a modifier held, replacing otherwise — the same as a file manager.
    return { selected: new Set(modifiers.meta ? [...current, ...range] : range), anchor }
  }
  if (modifiers.meta) {
    const selected = new Set(current)
    if (selected.has(id)) selected.delete(id)
    else selected.add(id)
    return { selected, anchor: id }
  }
  return { selected: new Set([id]), anchor: id }
}

/**
 * Which paths an action on `id` applies to: the whole highlight when the clicked row is part
 * of it, otherwise just that row. Directory rows expand to the files beneath them.
 */
export function targetsOf(root: TreeDir, rows: readonly FlatRow[], selected: ReadonlySet<string>, id: string): string[] {
  const ids = selected.has(id) ? rows.filter((row) => selected.has(row.id)).map((row) => row.id) : [id]
  const kinds = new Map(rows.map((row) => [row.id, row.kind]))
  const paths = ids.flatMap((rowId) => (kinds.get(rowId) === 'dir' ? filesUnder(root, rowId) : [rowId]))
  return [...new Set(paths)]
}
