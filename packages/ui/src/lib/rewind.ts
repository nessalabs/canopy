/**
 * Putting a turn's files back: what to ask the daemon for, and how the confirm dialog reads.
 * Pure — the panel and the transcript both go through here so they agree on what is rewindable.
 */
import type { RewindInput, RewindResult, TurnExtras } from '@canopy/shared'
import type { Turn } from '@canopy/shared/agent-stream'

import type { TurnSnapshot } from './turn-changes'

/** How many paths the dialog lists before it counts the rest. */
export const FILE_ROWS = 10

/**
 * What a rewind of `turn` would be addressed by, or null when the turn cannot be rewound: it has
 * no prompt (a resumed session starts mid-conversation) or the session file recorded no provider
 * id for it, which every turn from before rewind support is missing.
 *
 * A hook snapshot is the better mechanism — it restores the worktree exactly, shell writes and
 * all — so its `before` tree is passed whenever one was recorded; without it the daemon falls
 * back to the provider's own checkpoint.
 */
export function rewindInputFor(
  turn: Turn | undefined,
  extras: Record<string, TurnExtras>,
  snapshot: TurnSnapshot | undefined,
  cwd: string
): RewindInput | null {
  const messageId = turn?.prompt ? extras[turn.prompt.id]?.messageId : undefined
  if (!messageId || !cwd) return null
  return { messageId, cwd, ...(snapshot ? { tree: snapshot.before } : {}) }
}

/** Why the action is unavailable, for the tooltip on the disabled button. */
export const NO_MESSAGE_ID = 'This turn predates rewind support'

/** What each mechanism actually covers, so nobody expects a shell command to be undone by a checkpoint. */
export const SOURCE_NOTE: Record<RewindResult['source'], string> = {
  snapshot: 'Exact worktree snapshot (everything the turn changed, shell commands included)',
  checkpoint: 'Claude Code checkpoint (files written by its edit tools; shell side effects stay)'
}

/** A rewind is not scoped to the turn: anything written on top of these files goes back too. */
export const LATER_TURNS_NOTE = "Later turns' edits to these files are undone too."

/** The first `cap` paths and how many are left over. */
export function filePreview(files: readonly string[], cap = FILE_ROWS): { shown: readonly string[]; more: number } {
  return { shown: files.slice(0, cap), more: Math.max(0, files.length - cap) }
}

/** `+12 −3`, or undefined when the daemon counted no lines (a dry run on a checkpoint may not). */
export function lineCounts(result: Pick<RewindResult, 'insertions' | 'deletions'>): string | undefined {
  if (result.insertions === undefined && result.deletions === undefined) return undefined
  return `+${result.insertions ?? 0} −${result.deletions ?? 0}`
}

/** The panel's line once a rewind has run. */
export function rewoundLine(result: Pick<RewindResult, 'filesChanged'>): string {
  const count = result.filesChanged.length
  return count === 0 ? 'Nothing to rewind — those files already match' : `Rewound ${count} file${count === 1 ? '' : 's'}`
}
