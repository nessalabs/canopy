import { createContext, useContext } from 'react'
import { Bot } from 'lucide-react'

import type { GitHubNote } from '@canopy/shared'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * Hands one GitHub comment to an agent. The Git tab provides it, so a comment shown anywhere
 * under it — the Comments pane, a line in Files changed, the PR's conversation — can offer the
 * button without every view in between passing a callback along.
 */
const SendToAgent = createContext<((note: GitHubNote) => void) | null>(null)

export const SendToAgentProvider = SendToAgent.Provider

/** The per-comment "Send to agent" button. Renders nothing where no Git tab provides a destination. */
export function SendToAgentButton({ note, className }: { note: () => GitHubNote; className?: string }): React.JSX.Element | null {
  const send = useContext(SendToAgent)
  if (!send) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className={cn('size-7 shrink-0 text-muted-foreground hover:text-primary', className)} aria-label="Send to agent" onClick={() => send(note())}>
          <Bot className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Send to agent</TooltipContent>
    </Tooltip>
  )
}
