import { Fragment } from 'react'
import { Columns2 } from 'lucide-react'

import type { AgentSessionSummary, SessionOrigin, SessionRef } from '@canopy/shared'

import { IconAction } from '@/components/icon-action'
import { VIEW_DRAG_TYPE } from '@/components/panel-shell'
import { RandomAvatar } from '@/components/ui/random-avatar'
import { ScrollArea } from '@/components/ui/scroll-area'
import { StatusDot } from '@/components/ui/status-dot'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { relativeTime } from '@/lib/format'
import { sessionPanelId } from '@/lib/session-panels'
import { cn } from '@/lib/utils'

import { ProviderIcon } from './provider-icon'

const STATUS_LABEL = { busy: 'Working now', idle: 'Open in a terminal, waiting' } as const

/** The last segment of a checkout's path: what a person calls the worktree. */
const checkoutName = (cwd: string): string => cwd.replace(/\/+$/, '').split('/').pop() || cwd

/** The sessions of one other checkout, under a heading that says where they ran. */
interface Group {
  key: string
  origin: SessionOrigin
  sessions: AgentSessionSummary[]
}

/**
 * Other checkouts' sessions, one group per checkout, the most recently active first. In a worktree
 * the one group is the main checkout, and its sessions on this worktree's branch lead: they are the
 * conversations that were about this branch before (or instead of) any that ran here.
 */
function groupsOf(elsewhere: AgentSessionSummary[], branch: string | null): Group[] {
  const groups = new Map<string, Group>()
  for (const session of elsewhere) {
    if (!session.origin) continue
    const key = session.origin.kind === 'main' ? 'main' : session.origin.path
    const group = groups.get(key) ?? { key, origin: session.origin, sessions: [] }
    group.sessions.push(session)
    groups.set(key, group)
  }
  const onBranch = (session: AgentSessionSummary): number => (branch !== null && session.gitBranch === branch ? 1 : 0)
  for (const group of groups.values()) group.sessions.sort((a, b) => onBranch(b) - onBranch(a) || b.updatedAt - a.updatedAt)
  return [...groups.values()].sort((a, b) => (b.sessions[0]?.updatedAt ?? 0) - (a.sessions[0]?.updatedAt ?? 0))
}

function GroupHeading({ origin }: { origin: SessionOrigin }): React.JSX.Element {
  const name = origin.kind === 'main' ? 'Main checkout' : origin.name
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <li role="presentation" className="mt-3 flex min-w-0 items-center gap-1.5 px-3 pb-1 text-[11px] font-medium text-muted-foreground">
          <span className="truncate">{name}</span>
          {origin.branch && origin.kind !== 'main' && origin.branch !== origin.name ? <span className="truncate font-mono text-[10px] font-normal">{origin.branch}</span> : null}
          {origin.kind === 'removed' ? <span className="shrink-0 rounded-sm bg-muted px-1 py-px font-mono text-[10px] font-normal">removed</span> : null}
        </li>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-xs">
        {origin.kind === 'removed'
          ? `Ran in ${origin.path}, which is gone. The transcripts are kept; a message continues the session in ${origin.runIn}.`
          : `Ran in ${origin.path}. A message continues the session there.`}
      </TooltipContent>
    </Tooltip>
  )
}

/** What a session is called: its own title, or the start of its id when it never got one. */
export const sessionTitle = (session: Pick<AgentSessionSummary, 'title' | 'sessionId'>): string => session.title || session.sessionId.slice(0, 8)

/** What a row does besides becoming the main conversation: open beside it, by button or by drag. */
interface RowActions {
  onSelect: (ref: SessionRef) => void
  onOpenBeside?: (ref: SessionRef) => void
}

function SessionRow({ session, active, actions, branch }: { session: AgentSessionSummary; active: boolean; actions: RowActions; branch: string | null }): React.JSX.Element {
  const title = sessionTitle(session)
  const ref: SessionRef = { provider: session.provider, sessionId: session.sessionId }
  const { onSelect, onOpenBeside } = actions
  return (
    <li className="group/session relative">
      <button
        type="button"
        role="option"
        aria-selected={active}
        draggable={onOpenBeside !== undefined}
        onDragStart={(event) => {
          event.dataTransfer.setData(VIEW_DRAG_TYPE, sessionPanelId(ref))
          event.dataTransfer.effectAllowed = 'copy'
        }}
        className={cn('flex w-full min-w-0 items-start gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent/50', active && 'bg-accent')}
        onClick={() => onSelect(ref)}
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
            {session.origin?.kind === 'main' && branch !== null && session.gitBranch === branch ? (
              <span className="truncate rounded-sm bg-muted px-1 py-px" title={`This session was on ${branch} when it last ran`}>
                this branch
              </span>
            ) : null}
          </span>
        </span>
      </button>
      {onOpenBeside && !active ? (
        <IconAction label="Open beside — or drag it onto a panel" className="absolute top-2 right-2 opacity-0 group-hover/session:opacity-100 focus-visible:opacity-100" onClick={() => onOpenBeside(ref)}>
          <Columns2 className="size-3.5" />
        </IconAction>
      ) : null}
    </li>
  )
}

/**
 * Every agent session that worked in this worktree — the ones that ran in its checkout and the
 * ones that came here from another (a session started in the main checkout and told to work
 * in this one) — then, under a heading each, the project's other checkouts' sessions: all of
 * them in the main checkout, removed worktrees included, and the main checkout's in a worktree.
 * The avatar is seeded by session id so each reads distinct.
 */
export function SessionRail({
  sessions,
  elsewhere = [],
  branch = null,
  selected,
  onSelect,
  onOpenBeside,
  className
}: {
  sessions: AgentSessionSummary[]
  elsewhere?: AgentSessionSummary[]
  /** This checkout's branch: main-checkout sessions on it are marked and listed first. */
  branch?: string | null
  selected?: AgentSessionSummary
  onSelect: (ref: SessionRef) => void
  /** Opens a session in a pane of its own beside the main conversation; rows drag there too. */
  onOpenBeside?: (ref: SessionRef) => void
  className?: string
}): React.JSX.Element {
  const actions: RowActions = { onSelect, onOpenBeside }
  const isSelected = (session: AgentSessionSummary): boolean => session.sessionId === selected?.sessionId && session.provider === selected?.provider
  const groups = groupsOf(elsewhere, branch)
  return (
    // Radix's viewport lays content out as a table that grows to its widest child, which
    // defeats `truncate`; forcing block layout keeps rows inside the rail's width.
    <ScrollArea className={cn('h-full [&_[data-radix-scroll-area-viewport]>div]:!block', className)}>
      <ul className="flex flex-col gap-0.5 p-2" role="listbox" aria-label="Agent sessions">
        {sessions.map((session) => (
          <SessionRow key={`${session.provider}:${session.sessionId}`} session={session} active={isSelected(session)} actions={actions} branch={branch} />
        ))}
        {sessions.length === 0 ? <li className="p-3 text-xs text-muted-foreground">No sessions here yet.</li> : null}
        {groups.map((group) => (
          <Fragment key={group.key}>
            <GroupHeading origin={group.origin} />
            {group.sessions.map((session) => (
              <SessionRow key={`${session.provider}:${session.sessionId}`} session={session} active={isSelected(session)} actions={actions} branch={branch} />
            ))}
          </Fragment>
        ))}
      </ul>
    </ScrollArea>
  )
}
