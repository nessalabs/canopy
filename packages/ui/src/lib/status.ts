// Presentation mappings from domain states to nessa-ui primitives.
import { ENV_STATE_LABEL, SERVICE_DOT, SERVICE_LABEL, type EnvState, type WorktreeState } from '@canopy/shared'

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

export const FILE_STATUS_LABEL: Record<'A' | 'M' | 'D' | 'T' | 'U', string> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  T: 'type',
  U: 'untracked'
}
