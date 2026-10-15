import type { Autonomy } from '@canopy/shared'

import type { ComposerAccessModeValue } from '@/components/ui/composer-access-mode'

/** The composer's shield states ↔ the daemon's autonomy levels (Claude permission modes). */
export const ACCESS_TO_AUTONOMY: Record<ComposerAccessModeValue, Autonomy> = {
  'ask-approval': 'read-only', // default: asks before every edit or command that is not read-only
  'auto-approval': 'edit', // auto: a classifier approves routine calls, asks only for risky ones
  'full-access': 'full' // bypassPermissions
}

export const AUTONOMY_TO_ACCESS: Record<Autonomy, ComposerAccessModeValue> = {
  'read-only': 'ask-approval',
  edit: 'auto-approval',
  full: 'full-access'
}
