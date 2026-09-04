import type { AgentProvider, Effort } from '@canopy/shared'

import type { ModelPickerGroup } from '@/components/ui/model-picker'
import { ProviderIcon } from '@/components/agent/provider-icon'

/** Model aliases the Claude Agent SDK resolves; the id is passed straight through as `model`. */
// The picker's trigger shows the *model's* icon, so every entry carries its provider mark.
const claude = (id: string, label: string, description: string) => ({ id, label, description, icon: <ProviderIcon provider="claude" /> })

export const MODEL_GROUPS: Record<AgentProvider, ModelPickerGroup> = {
  claude: {
    id: 'claude',
    label: 'Claude',
    icon: <ProviderIcon provider="claude" />,
    models: [
      claude('fable', 'Fable 5', 'Most capable'),
      claude('opus', 'Opus 5', 'Deepest reasoning'),
      claude('sonnet', 'Sonnet 5', 'Fast and capable'),
      claude('haiku', 'Haiku 4.5', 'Quickest')
    ]
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    icon: <ProviderIcon provider="codex" />,
    // Model selection is not wired for Codex turns yet (docs/todo.md).
    disabled: true,
    models: []
  }
}

const ALIASES: Array<[RegExp, string]> = [[/opus/, 'opus'], [/sonnet/, 'sonnet'], [/haiku/, 'haiku'], [/fable/, 'fable']]

/** `claude-opus-5` → `opus`: the alias the SDK accepts and the picker lists. Unknown ids pass through. */
export function modelAlias(modelId: string | undefined): string | undefined {
  if (!modelId) return undefined
  return ALIASES.find(([pattern]) => pattern.test(modelId))?.[1] ?? modelId
}

/** The provider's catalog, extended with the session's own model when it is not listed. */
export function modelGroupFor(provider: AgentProvider, detected: string | undefined): ModelPickerGroup {
  const group = MODEL_GROUPS[provider]
  if (!detected || group.models.some((m) => m.id === detected)) return group
  return { ...group, models: [{ id: detected, label: detected, description: 'Model of this session', icon: group.icon }, ...group.models] }
}

/** Effort levels as the SDK names them, labelled for the thinking slider. */
export const EFFORT_LEVELS: Array<{ value: Effort; label: string; description: string }> = [
  { value: 'low', label: 'Low', description: 'Quick, focused reasoning' },
  { value: 'medium', label: 'Medium', description: 'Balanced speed and depth' },
  { value: 'high', label: 'High', description: 'More deliberate reasoning' },
  { value: 'xhigh', label: 'Extra high', description: 'Deep, extended reasoning' }
]
