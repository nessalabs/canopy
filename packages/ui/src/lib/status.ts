// Presentation mappings from domain states to nessa-ui primitives.
import type { WorktreeState } from '@canopy/shared'

type DotStatus = 'running' | 'success' | 'error' | 'idle'
type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline'

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

export const FILE_STATUS_LABEL: Record<'A' | 'M' | 'D' | 'T' | 'U', string> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  T: 'type',
  U: 'untracked'
}
