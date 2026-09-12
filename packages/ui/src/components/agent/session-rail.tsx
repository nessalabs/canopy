import type { AgentSessionSummary, SessionRef } from '@canopy/shared'

import { RandomAvatar } from '@/components/ui/random-avatar'
import { ScrollArea } from '@/components/ui/scroll-area'
import { StatusDot } from '@/components/ui/status-dot'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'

import { ProviderIcon } from './provider-icon'

const STATUS_LABEL = { busy: 'Working now', idle: 'Open in a terminal, waiting' } as const

/** The last segment of a checkout's path: what a person calls the worktree. */
const checkoutName = (cwd: string): string => cwd.replace(/\/+$/, '').split('/').pop() || cwd

/**
 * Every agent session that worked in this worktree — the ones that ran in its checkout and the
 * ones that came here from another (a session started in the main checkout and told to work
 * in this one). The avatar is seeded by session id so each reads distinct.
 */
export function SessionRail({ sessions, selected, onSelect, className }: { sessions: AgentSessionSummary[]; selected?: AgentSessionSummary; onSelect: (ref: SessionRef) => void; className?: string }): React.JSX.Element {
  return (
    // Radix's viewport lays content out as a table that grows to its widest child, which
    // defeats `truncate`; forcing block layout keeps rows inside the rail's width.
    <ScrollArea className={cn('h-full [&_[data-radix-scroll-area-viewport]>div]:!block', className)}>
      <ul className="flex flex-col gap-0.5 p-2" role="listbox" aria-label="Agent sessions">
        {sessions.map((session) => {
          const active = session.sessionId === selected?.sessionId && session.provider === selected?.provider
          const title = session.title || session.sessionId.slice(0, 8)
          return (
            <li key={`${session.provider}:${session.sessionId}`}>
              <button
                type="button"
                role="option"
                aria-selected={active}
                className={cn('flex w-full min-w-0 items-start gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent/50', active && 'bg-accent')}
                onClick={() => onSelect({ provider: session.provider, sessionId: session.sessionId })}
              >
                <RandomAvatar seed={session.sessionId} name={title} className="mt-0.5 size-6 shrink-0 rounded-full" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="block truncate pr-1 text-sm">{title}</span>
                    </TooltipTrigger>
                    <TooltipContent side="right" className="max-w-xs">
                      {title}
                    </TooltipContent>
                  </Tooltip>
                  <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap font-mono text-[10px] text-muted-foreground">
                    <ProviderIcon provider={session.provider} className="size-3" />
                    {relativeTime(session.updatedAt)}
                    {session.status ? (
                      <StatusDot status={session.status === 'busy' ? 'running' : 'idle'} aria-label={STATUS_LABEL[session.status]} title={STATUS_LABEL[session.status]} />
                    ) : session.active ? (
                      <StatusDot status="idle" aria-label="Open in a terminal" title="Open in a terminal" />
                    ) : null}
                    {session.visiting && session.cwd ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="truncate rounded-sm bg-muted px-1 py-px">from {checkoutName(session.cwd)}</span>
                        </TooltipTrigger>
                        <TooltipContent side="right" className="max-w-xs">
                          Started in {session.cwd}; its tool calls work in this worktree.
                        </TooltipContent>
                      </Tooltip>
                    ) : null}
                  </span>
                </span>
              </button>
            </li>
          )
        })}
        {sessions.length === 0 ? <li className="p-3 text-xs text-muted-foreground">No sessions yet.</li> : null}
      </ul>
    </ScrollArea>
  )
}
