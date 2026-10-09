import { History } from 'lucide-react'

import type { GitAgentSession, SessionRef } from '@canopy/shared'

import { ProviderIcon } from '@/components/agent/provider-icon'
import { sessionTitle } from '@/components/agent/session-rail'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { relativeTime } from '@/lib/format'
import { sameSession, type AgentTab } from '@/lib/git-agent'

/** How many past conversations the empty panel offers before pointing at the full history. */
const RECENT = 5

/** One past conversation: whose, what about, when it last moved, and whether a tab shows it now. */
function Entry({ session, open }: { session: GitAgentSession; open: boolean }): React.JSX.Element {
  return (
    <>
      <ProviderIcon provider={session.provider} className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{sessionTitle(session)}</span>
      {open ? <span className="size-1.5 shrink-0 rounded-full bg-foreground/60" aria-label="Open in a tab" /> : null}
      <span className="shrink-0 text-muted-foreground tabular-nums">{relativeTime(session.updatedAt)}</span>
    </>
  )
}

const isOpen = (tabs: AgentTab[], session: SessionRef): boolean => tabs.some((tab) => sameSession(tab.session, session))

/** The Git Agent's past conversations on this worktree, from the panel's header; picking one opens it in a tab. */
export function HistoryMenu({ history, tabs, onOpen }: { history: GitAgentSession[]; tabs: AgentTab[]; onOpen: (session: SessionRef) => void }): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-6" aria-label="Past conversations" title="Past conversations" disabled={history.length === 0}>
          <History className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-96 w-80 overflow-y-auto">
        <DropdownMenuLabel className="text-xs">Past conversations</DropdownMenuLabel>
        {history.map((session) => (
          <DropdownMenuItem key={`${session.provider}:${session.sessionId}`} onSelect={() => onOpen(session)} className="gap-2 text-xs">
            <Entry session={session} open={isOpen(tabs, session)} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The newest few past conversations, for the panel with no tab open. */
export function RecentList({ history, onOpen }: { history: GitAgentSession[]; onOpen: (session: SessionRef) => void }): React.JSX.Element | null {
  if (history.length === 0) return null
  return (
    <div className="flex w-full max-w-72 flex-col gap-1 pt-3 text-start">
      <p className="px-2 text-[11px] font-medium text-muted-foreground">Recent conversations</p>
      <ul className="flex flex-col">
        {history.slice(0, RECENT).map((session) => (
          <li key={`${session.provider}:${session.sessionId}`}>
            <button type="button" onClick={() => onOpen(session)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-xs hover:bg-muted">
              <Entry session={session} open={false} />
            </button>
          </li>
        ))}
      </ul>
      {history.length > RECENT ? <p className="px-2 text-[11px] text-muted-foreground">The rest are under the clock above.</p> : null}
    </div>
  )
}
