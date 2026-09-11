import type { AgentModel, AgentProvider, Effort } from '@canopy/shared'

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

/**
 * What the model picker lists: the catalog the provider advertises when it has one (it knows
 * which models this account may actually use), else the built-in aliases — either way extended
 * with the session's own model when that is not among them.
 */
export function modelGroupFor(provider: AgentProvider, detected: string | undefined, advertised?: readonly AgentModel[]): ModelPickerGroup {
  const base = MODEL_GROUPS[provider]
  const group: ModelPickerGroup =
    advertised && advertised.length > 0
      ? { ...base, models: advertised.map((model) => ({ id: model.id, label: model.label, description: model.description, icon: base.icon })) }
      : base
  if (!detected || group.models.some((m) => m.id === detected)) return group
  return { ...group, models: [{ id: detected, label: detected, description: 'Model of this session', icon: group.icon }, ...group.models] }
}

/** Every effort the SDK names, labelled for the thinking slider. */
const EFFORT_LABELS: Record<Effort, { label: string; description: string }> = {
  low: { label: 'Low', description: 'Quick, focused reasoning' },
  medium: { label: 'Medium', description: 'Balanced speed and depth' },
  high: { label: 'High', description: 'More deliberate reasoning' },
  xhigh: { label: 'Extra high', description: 'Deep, extended reasoning' },
  max: { label: 'Max', description: 'Everything the model has' }
}

export interface EffortLevel {
  value: Effort
  label: string
  description: string
}

const level = (value: Effort): EffortLevel => ({ value, ...EFFORT_LABELS[value] })

/** The levels a session offers when the provider has not said otherwise. */
export const EFFORT_LEVELS: EffortLevel[] = [level('low'), level('medium'), level('high'), level('xhigh')]

/**
 * The thinking slider's stops for one model. A model the provider described carries its own list —
 * empty when it takes no effort parameter at all, which leaves the slider with nothing to offer.
 */
export function effortLevelsFor(modelId: string | undefined, advertised?: readonly AgentModel[]): EffortLevel[] {
  const model = advertised?.find((candidate) => candidate.id === modelId)
  if (!model) return EFFORT_LEVELS
  return model.effortLevels.map(level)
}
