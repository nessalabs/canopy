// Presentation mappings from domain states to nessa-ui primitives.
import { ENV_STATE_LABEL, SERVICE_DOT, SERVICE_LABEL, type EnvState, type Worktree, type WorktreeState } from '@canopy/shared'

import { plural } from './format'

type DotStatus = 'running' | 'success' | 'error' | 'idle'
type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline'

/** Re-exported so screens take one import for every status mapping. */
export { ENV_STATE_LABEL, SERVICE_DOT, SERVICE_LABEL }

export const WORKTREE_DOT: Record<WorktreeState, DotStatus> = {
  clean: 'success',
  dirty: 'running',
  detached: 'idle',
  missing: 'error'
}

export const WORKTREE_BADGE: Record<WorktreeState, { label: string; variant: BadgeVariant }> = {
  clean: { label: 'Clean', variant: 'outline' },
  dirty: { label: 'Changes', variant: 'default' },
  detached: { label: 'Detached', variant: 'secondary' },
  missing: { label: 'Missing', variant: 'destructive' }
}

/** The environment's lifecycle state as a badge: transitions are quiet, failures are loud. */
export const ENV_STATE_BADGE: Record<EnvState, { label: string; variant: BadgeVariant }> = {
  none: { label: ENV_STATE_LABEL.none, variant: 'outline' },
  creating: { label: ENV_STATE_LABEL.creating, variant: 'secondary' },
  provisioning: { label: ENV_STATE_LABEL.provisioning, variant: 'secondary' },
  stopped: { label: ENV_STATE_LABEL.stopped, variant: 'outline' },
  starting: { label: ENV_STATE_LABEL.starting, variant: 'secondary' },
  running: { label: ENV_STATE_LABEL.running, variant: 'default' },
  degraded: { label: ENV_STATE_LABEL.degraded, variant: 'destructive' },
  stopping: { label: ENV_STATE_LABEL.stopping, variant: 'secondary' },
  error: { label: ENV_STATE_LABEL.error, variant: 'destructive' },
  destroying: { label: ENV_STATE_LABEL.destroying, variant: 'secondary' }
}

/** What a worktree's `merged` fact means once the working tree is taken into account. */
export interface MergedVerdict {
  /** The fact about the branch: the base already has everything this branch committed. */
  merged: boolean
  /** Nothing is lost by removing the worktree — merged, and nothing uncommitted sitting in it. */
  disposable: boolean
  label: string
}

/**
 * What a worktree's `merged` fact reads as, or null when there is nothing to say (the main
 * checkout, or a daemon that could not tell). Lists show only the disposable state as an icon;
 * the unmerged wording is for the places that are about to destroy something.
 *
 * `merged` is a fact about the *branch*, and the two questions it gets asked are not the same
 * one: "has this work landed" and "is this worktree safe to let go of". Uncommitted changes are
 * not on the branch at all, so no merge carries them anywhere — a checkout holding them is not
 * disposable however thoroughly its branch has landed.
 */
export function mergedLabel(worktree: Pick<Worktree, 'isMain' | 'baseBranch' | 'status'>): MergedVerdict | null {
  const merged = worktree.status?.merged
  if (worktree.isMain || merged === null || merged === undefined) return null
  const ahead = worktree.status?.ahead ?? null
  const dirty = worktree.status?.dirtyTotal ?? 0
  if (!merged) {
    const aheadBy = ahead !== null && ahead > 0 ? ` (${plural(ahead, 'commit')} ahead)` : ''
    return { merged, disposable: false, label: `Not merged into ${worktree.baseBranch}${aheadBy}` }
  }
  // A branch that never committed anything has not "merged" in any sense a reader would
  // recognise; it simply has nothing of its own. Both are safe to let go, and saying so
  // accurately is the difference between a tick that can be trusted and one that cannot.
  const landed = ahead === 0 ? `Nothing of its own to land on ${worktree.baseBranch}` : `Merged into ${worktree.baseBranch}`
  if (dirty === 0) return { merged, disposable: true, label: landed }
  return { merged, disposable: false, label: `${landed}, but ${plural(dirty, 'uncommitted change')} here would be lost` }
}

/** The merge button's state: whether to offer it, whether it can be pressed, and why not. */
export interface MergeAffordance {
  shown: boolean
  enabled: boolean
  label: string
  hint: string
}

/**
 * Whether a worktree's branch can be landed on its base, and what to say when it cannot.
 *
 * A worktree with no checkout has a null status, which means *nothing about it is known* —
 * not that it has nothing to land. Reading that as `ahead ?? 0` produces "No commits main
 * lacks", a confident statement of a git fact nobody ever established, next to a diff pane
 * that could not read the branch at all.
 */
export function mergeAffordance(worktree: Pick<Worktree, 'isMain' | 'branch' | 'baseBranch' | 'status'>): MergeAffordance {
  const base = worktree.baseBranch
  const label = `Merge into ${base}`
  // The primary checkout is the base, and a detached HEAD has no branch to land.
  if (worktree.isMain || worktree.branch === null) return { shown: false, enabled: false, label, hint: '' }
  const status = worktree.status
  if (status === null) return { shown: true, enabled: false, label, hint: 'This worktree has no checkout on disk; nothing can be read from it' }
  // Null ahead/behind is git declining to compare: the base is not a branch here.
  if (status.ahead === null) return { shown: true, enabled: false, label, hint: `${base} is not a branch in this repository` }
  if (status.merged === true) return { shown: true, enabled: false, label: 'Merged', hint: `Already merged into ${base}` }
  if (status.ahead === 0) return { shown: true, enabled: false, label, hint: `No commits ${base} lacks` }
  return { shown: true, enabled: true, label, hint: `Land ${plural(status.ahead, 'commit')} on ${base}` }
}

export const FILE_STATUS_LABEL: Record<'A' | 'M' | 'D' | 'T' | 'U', string> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  T: 'type',
  U: 'untracked'
}
