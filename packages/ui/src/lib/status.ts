// Presentation mappings from domain states to nessa-ui primitives.
import { ENV_STATE_LABEL, SERVICE_DOT, SERVICE_LABEL, type EnvState, type Worktree, type WorktreeState } from '@canopy/shared'

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

/**
 * What a worktree's `merged` fact reads as, or null when there is nothing to say (the main
 * checkout, or a daemon that could not tell). Lists show only the merged state as an icon;
 * the unmerged wording is for the places that are about to destroy something.
 */
export function mergedLabel(worktree: Pick<Worktree, 'isMain' | 'baseBranch' | 'status'>): { merged: boolean; label: string } | null {
  const merged = worktree.status?.merged
  if (worktree.isMain || merged === null || merged === undefined) return null
  const ahead = worktree.status?.ahead ?? null
  const behindBy = ahead !== null && ahead > 0 ? ` (${ahead} commit${ahead === 1 ? '' : 's'} ahead)` : ''
  return merged ? { merged, label: `Merged into ${worktree.baseBranch}` } : { merged, label: `Not merged into ${worktree.baseBranch}${behindBy}` }
}

export const FILE_STATUS_LABEL: Record<'A' | 'M' | 'D' | 'T' | 'U', string> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  T: 'type',
  U: 'untracked'
}
