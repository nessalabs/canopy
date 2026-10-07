import { Plus } from 'lucide-react'

import type { AgentProvider } from '@canopy/shared'

import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

import { ProviderIcon } from './provider-icon'

const NAMES: Record<AgentProvider, string> = { claude: 'Claude Code', codex: 'Codex' }

/**
 * The Agent section's primary action in the top bar: starts composing a new session. One installed provider starts it directly; several
 * offer a choice. `active` marks that a new session is being composed right now.
 */
export function NewSessionButton({ providers, active, onStart, disabled }: { providers: AgentProvider[]; active?: AgentProvider; onStart: (provider: AgentProvider) => void; disabled?: boolean }): React.JSX.Element {
  const [only] = providers
  const trigger = (
    <Button
      size="sm"
      className={cn('h-7 text-xs', active && 'ring-2 ring-ring/40')}
      aria-label="New session"
      disabled={disabled || providers.length === 0}
      onClick={providers.length === 1 && only ? () => onStart(only) : undefined}
    >
      <Plus aria-hidden="true" />
      <span className="hidden @3xl:inline">New session</span>
    </Button>
  )
  if (providers.length <= 1) return trigger
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {providers.map((provider) => (
          <DropdownMenuItem key={provider} onSelect={() => onStart(provider)}>
            <ProviderIcon provider={provider} className="size-4" /> New {NAMES[provider]} session
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
