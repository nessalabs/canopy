import type { Autonomy } from '@canopy/shared'

import type { ComposerAccessModeValue } from '@/components/ui/composer-access-mode'

/** The composer's shield states ↔ the daemon's autonomy levels (Claude permission modes). */
export const ACCESS_TO_AUTONOMY: Record<ComposerAccessModeValue, Autonomy> = {
  'ask-approval': 'read-only', // plan: the agent proposes, edits nothing
  'auto-approval': 'edit', // acceptEdits: edits the worktree, asks for anything else
  'full-access': 'full' // bypassPermissions
}

export const AUTONOMY_TO_ACCESS: Record<Autonomy, ComposerAccessModeValue> = {
  'read-only': 'ask-approval',
  edit: 'auto-approval',
  full: 'full-access'
}
