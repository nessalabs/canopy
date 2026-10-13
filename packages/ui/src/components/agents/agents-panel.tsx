import { useState } from 'react'
import { useLocation } from 'wouter'

import type { FleetAgent, Worktree } from '@canopy/shared'

import { ProviderIcon } from '@/components/agent/provider-icon'
import { AskCard } from '@/components/agent/transcript'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SegmentedControl, SegmentedControlOption } from '@/components/ui/segmented-control'
import { StatusDot, type StatusDotProps } from '@/components/ui/status-dot'
import { agentHref, FLEET_FILTERS, filterFleet, fleetCounts, fleetSections, type FleetFilter } from '@/lib/agent-fleet'
import { useAgentFleet, useAnswerAsk, useProjects, useWorktrees } from '@/lib/api-hooks'
import { relativeTime } from '@/lib/format'

const ACTIVITY_LOOK: Record<FleetAgent['activity'], { label: string; dot: NonNullable<StatusDotProps['status']> }> = {
  approval: { label: 'Needs approval', dot: 'attention' },
  running: { label: 'Running', dot: 'running' },
  done: { label: 'Completed', dot: 'idle' }
}

/**
 * What the agent is waiting on, answerable right here with the same cards its chat shows. The
 * answer reaches that chat too, through the turn's own stream.
 */
function Asks({ agent }: { agent: FleetAgent }): React.JSX.Element | null {
  const answer = useAnswerAsk()
  if (agent.asks.length === 0) return null
  const ref = { provider: agent.provider, sessionId: agent.sessionId }
  return (
    <div className="flex flex-col gap-2 px-2 pt-1 pb-2">
      {agent.asks.map((ask) => (
        <AskCard key={ask.id} ask={ask} className="w-full" onAnswer={(input) => answer.mutate({ ref, input })} />
      ))}
    </div>
  )
}

function AgentRow({ agent, where }: { agent: FleetAgent; where: string }): React.JSX.Element {
  const [, navigate] = useLocation()
  const look = ACTIVITY_LOOK[agent.activity]
  const title = agent.title || (agent.kind === 'canopy' ? 'Git Agent' : agent.sessionId.slice(0, 8))
  return (
    <li>
      <button type="button" className="flex w-full min-w-0 flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/50" onClick={() => navigate(agentHref(agent))}>
        <span className="flex min-w-0 items-center gap-1.5">
          <StatusDot status={look.dot} aria-label={look.label} title={look.label} />
          <span className="min-w-0 flex-1 truncate text-sm" title={title}>
            {title}
          </span>
          {agent.activity === 'approval' ? (
            <Badge variant="outline" className="h-4 shrink-0 border-nessa-attention/50 px-1.5 text-[10px] text-nessa-attention">
              Needs approval
            </Badge>
          ) : null}
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground" title={relativeTime(agent.updatedAt)}>
            {relativeTime(agent.updatedAt, Date.now(), 'narrow')}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 pl-3.5 font-mono text-[10px] text-muted-foreground">
          <ProviderIcon provider={agent.provider} className="size-3 shrink-0" />
          <span className="truncate" title={where}>
            {where}
          </span>
        </span>
      </button>
      <Asks agent={agent} />
    </li>
  )
}

/**
 * Every agent Canopy can see, whatever worktree is on screen: Canopy's own first, then each
 * project's, filtered by what they are doing. Opening one goes to its worktree's tab.
 */
export function AgentsPanel(): React.JSX.Element {
  const [filter, setFilter] = useState<FleetFilter>('all')
  const fleet = useAgentFleet()
  const projects = useProjects().data ?? []
  const worktrees = new Map((useWorktrees().data ?? []).map((wt: Worktree) => [wt.id, wt]))
  const agents = fleet.data ?? []
  const counts = fleetCounts(agents)
  const sections = fleetSections(filterFleet(agents, filter), projects)
  const projectName = (id: string): string => projects.find((project) => project.id === id)?.name ?? ''
  const where = (agent: FleetAgent, section: string): string => {
    const worktree = worktrees.get(agent.worktreeId)?.name ?? ''
    return section === 'canopy' ? `${projectName(agent.projectId)} · ${worktree}` : worktree
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <SegmentedControl aria-label="Show agents" value={filter} onValueChange={(value) => setFilter(value as FleetFilter)} className="mx-2 my-1.5 gap-0 self-start border-0 p-0">
        {FLEET_FILTERS.map((option) => (
          <SegmentedControlOption key={option.value} value={option.value} className="h-6 gap-1 px-1.5 text-xs">
            {option.label}
            <span className="font-mono text-[10px] text-muted-foreground">{counts[option.value]}</span>
          </SegmentedControlOption>
        ))}
      </SegmentedControl>
      <ScrollArea className="min-h-0 flex-1 [&_[data-radix-scroll-area-viewport]>div]:!block">
        {sections.map((section) => (
          <section key={section.id} aria-label={section.label} className="px-1 pb-2">
            <h3 className="flex items-center gap-1.5 px-2 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">
              <span className="truncate">{section.label}</span>
              <span className="font-mono text-[10px] font-normal">{section.agents.length}</span>
            </h3>
            <ul className="flex flex-col gap-0.5">
              {section.agents.map((agent) => (
                <AgentRow key={`${agent.provider}:${agent.sessionId}`} agent={agent} where={where(agent, section.id)} />
              ))}
            </ul>
          </section>
        ))}
        {sections.length === 0 ? (
          <p className="p-4 text-xs text-muted-foreground">{fleet.isPending ? 'Looking for agents…' : fleet.isError ? 'Could not list agents.' : 'No agents here.'}</p>
        ) : null}
      </ScrollArea>
    </div>
  )
}
