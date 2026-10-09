import { AgentAvatar } from '@/components/agent/agent-avatar'
import { Button } from '@/components/ui/button'
import { StatusDot, type StatusDotProps } from '@/components/ui/status-dot'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { AgentStatus } from '@/lib/git-agent'
import { cn } from '@/lib/utils'

/**
 * How each state reads at a glance: nessa's status dot, the tab's tint, and the words for
 * tooltips and screen readers. Amber asks for the user, the thinking colour works, green has
 * finished and is waiting to be read, red stopped.
 */
export const STATUS_LOOK: Record<AgentStatus, { label: string; dot: NonNullable<StatusDotProps['status']>; tint: string }> = {
  input: { label: 'Needs your input', dot: 'attention', tint: 'bg-nessa-attention/15 font-semibold' },
  running: { label: 'Working', dot: 'running', tint: '' },
  error: { label: 'Stopped with an error', dot: 'error', tint: 'bg-destructive/10' },
  done: { label: 'Finished — not read yet', dot: 'success', tint: 'bg-nessa-diff-addition/12 font-semibold' },
  idle: { label: 'Idle', dot: 'idle', tint: '' }
}

/**
 * The top bar's switch for the Git Agent. Its dot carries the most pressing state across every
 * tab, so a question or a finished review shows even while the panel is closed.
 */
export function GitAgentToggle({ seed, status, open, onToggle }: { seed: string; status: AgentStatus; open: boolean; onToggle: () => void }): React.JSX.Element {
  const look = STATUS_LOOK[status]
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant={open ? 'secondary' : 'outline'} size="sm" className={cn('h-7 text-xs', status === 'input' && 'ring-2 ring-nessa-attention/50')} aria-pressed={open} onClick={onToggle}>
          <span className="relative inline-flex">
            <AgentAvatar seed={seed} activity={status === 'running' ? 'working' : null} />
            {status === 'idle' ? null : <StatusDot status={look.dot} className="absolute -top-0.5 -right-0.5 size-1.5 ring-2 ring-background" />}
          </span>
          <span className="hidden @3xl:inline">Git Agent</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{status === 'idle' ? 'Ask the Git Agent about this change' : `Git Agent · ${look.label}`}</TooltipContent>
    </Tooltip>
  )
}
