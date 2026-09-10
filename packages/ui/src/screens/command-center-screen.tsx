import { useMemo, useState } from 'react'
import { Activity, FolderGit2, GitBranch, LayoutPanelLeft, ListTree, Play, Search, Square } from 'lucide-react'
import { useLocation } from 'wouter'

import { environmentDot, formatMem, isLive, serviceResources, type Worktree } from '@canopy/shared'

import { PanelShell, type PanelDef } from '@/components/panel-shell'
import { CoreGrid, SystemMemBar } from '@/components/resources/host-usage'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { FramedBox } from '@/components/ui/framed-box'
import { Input } from '@/components/ui/input'
import { Meter, type MeterSlot } from '@/components/ui/meter'
import { SegmentedControl, SegmentedControlOption } from '@/components/ui/segmented-control'
import { StatusDot } from '@/components/ui/status-dot'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useHost, useProjects, useWorktreeLifecycle, useWorktrees } from '@/lib/api-hooks'
import { PaneSplitDirection, createAppShellLayout, setSplitWeights, splitPane, type AppShellLayout } from '@/lib/app-shell-layout'
import { cpuScale, memScale } from '@/lib/environment-ui'
import { useHostSamples } from '@/lib/events-provider'
import { plural, relativeTime } from '@/lib/format'
import { ENV_STATE_BADGE, SERVICE_DOT, SERVICE_LABEL, WORKTREE_BADGE, WORKTREE_DOT } from '@/lib/status'

type Filter = 'all' | 'running' | 'attention' | 'stopped' | 'changes'

const FILTERS: Record<Filter, { label: string; matches: (worktree: Worktree) => boolean }> = {
  all: { label: 'All', matches: () => true },
  running: { label: 'Running', matches: (wt) => isLive(wt.environment.state) },
  attention: { label: 'Attention', matches: (wt) => wt.environment.state === 'degraded' || wt.environment.state === 'error' },
  stopped: { label: 'Stopped', matches: (wt) => wt.environment.state === 'stopped' || wt.environment.state === 'none' },
  changes: { label: 'Changes', matches: (wt) => (wt.status?.dirtyTotal ?? 0) > 0 }
}

/** The ports a worktree occupies: the allocation map when it has one, else whatever its services publish. */
function portsOf(worktree: Worktree): number[] {
  const allocated = Object.values(worktree.environment.ports)
  if (allocated.length > 0) return allocated
  return worktree.environment.services.filter((service) => !service.excluded).flatMap((service) => service.ports.map((port) => port.port))
}

/** One dot for the row; hovering it reveals every service's state. */
function HealthDot({ worktree }: { worktree: Worktree }): React.JSX.Element {
  const env = worktree.environment
  const provisioned = env.state !== 'none'
  const active = env.services.filter((service) => !service.excluded)
  const status = worktree.status

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex size-5 shrink-0 items-center justify-center">
          <StatusDot status={provisioned ? environmentDot(env) : WORKTREE_DOT[worktree.state]} aria-label={`${worktree.name} health`} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right">
        {provisioned && active.length > 0 ? (
          <div className="flex flex-col gap-1 py-0.5">
            {active.map((service) => (
              <span key={service.name} className="flex items-center gap-1.5 font-mono">
                <StatusDot status={SERVICE_DOT[service.status]} />
                {service.name}
                <span className="text-muted-foreground">{SERVICE_LABEL[service.status].toLowerCase()}</span>
              </span>
            ))}
          </div>
        ) : status ? (
          `${status.staged} staged · ${status.unstaged} unstaged · ${status.untracked} untracked`
        ) : (
          'Worktree directory is missing'
        )}
      </TooltipContent>
    </Tooltip>
  )
}

function LifecycleButton({ worktree, action, children }: { worktree: Worktree; action: 'start' | 'stop'; children: React.ReactNode }): React.JSX.Element {
  const lifecycle = useWorktreeLifecycle(worktree.id)
  const label = `${action === 'start' ? 'Start' : 'Stop'} ${worktree.name}`
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 disabled:opacity-40"
          aria-label={label}
          disabled={lifecycle.isPending}
          onClick={(event) => {
            event.stopPropagation()
            lifecycle.mutate(action)
          }}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{lifecycle.error ? `Failed: ${lifecycle.error.message}` : `${action === 'start' ? 'Start' : 'Stop'} services`}</TooltipContent>
    </Tooltip>
  )
}

function WorktreeRow({ worktree, projectName }: { worktree: Worktree; projectName: string }): React.JSX.Element {
  const [, navigate] = useLocation()
  const env = worktree.environment
  const gitBadge = WORKTREE_BADGE[worktree.state]
  const envBadge = ENV_STATE_BADGE[env.state]
  const status = worktree.status
  const resources = serviceResources(env.services)
  const ports = portsOf(worktree)
  const live = isLive(env.state)
  const startable = env.state === 'stopped' || env.state === 'error'
  const open = (): void => navigate(`/worktrees/${worktree.id}`)

  return (
    <div
      role="link"
      tabIndex={0}
      aria-label={`Open ${worktree.name}`}
      className="group flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 outline-none transition-colors [transition-duration:var(--nessa-motion-duration-fast)] hover:bg-accent/50 focus-visible:[outline-style:solid] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          open()
        }
      }}
    >
      <HealthDot worktree={worktree} />
      <span className="flex w-56 min-w-0 flex-col">
        <span className="truncate font-mono text-sm font-medium">{worktree.name}</span>
        <span className="flex items-center gap-1 truncate font-mono text-[10px] text-muted-foreground">
          <GitBranch className="size-2.5 shrink-0" />
          {projectName} · {worktree.branch ?? 'detached'}
        </span>
      </span>
      <Badge variant={env.state === 'none' ? gitBadge.variant : envBadge.variant} className="hidden w-28 justify-center text-[10px] sm:inline-flex">
        {env.state === 'none' ? (worktree.state === 'dirty' && status ? plural(status.dirtyTotal, 'change') : gitBadge.label) : envBadge.label}
      </Badge>
      {worktree.isMain ? (
        <Badge variant="outline" className="hidden text-[10px] xl:inline-flex">
          main checkout
        </Badge>
      ) : null}
      <span className="hidden flex-wrap gap-1 lg:flex">
        {ports.slice(0, 4).map((port) => (
          <span key={port} className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            :{port}
          </span>
        ))}
      </span>
      <span className="ml-auto flex items-center gap-3">
        {resources.processes > 0 ? (
          <span className="hidden font-mono text-[11px] tabular-nums text-muted-foreground sm:inline">
            {resources.cpuPct}% · {formatMem(resources.memMb)}
          </span>
        ) : null}
        {status?.lastCommit ? (
          <span className="hidden max-w-56 truncate text-[11px] text-muted-foreground xl:inline" title={status.lastCommit.subject}>
            {status.lastCommit.subject}
          </span>
        ) : null}
        {status?.lastCommit ? <span className="hidden w-20 text-right text-[10px] text-muted-foreground sm:inline">{relativeTime(status.lastCommit.at)}</span> : null}
        {startable ? (
          <LifecycleButton worktree={worktree} action="start">
            <Play className="size-3.5" />
          </LifecycleButton>
        ) : null}
        {live ? (
          <LifecycleButton worktree={worktree} action="stop">
            <Square className="size-3.5" />
          </LifecycleButton>
        ) : null}
      </span>
    </div>
  )
}

function WorktreesPanel(): React.JSX.Element {
  const worktrees = useWorktrees()
  const projects = useProjects().data ?? []
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const projectName = (id: string): string => projects.find((p) => p.id === id)?.name ?? ''

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (worktrees.data ?? []).filter(
      (wt) => FILTERS[filter].matches(wt) && (!needle || `${wt.name} ${wt.branch ?? ''} ${projectName(wt.projectId)}`.toLowerCase().includes(needle))
    )
  }, [worktrees.data, filter, query, projects])

  return (
    <div className="flex flex-col gap-2 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl value={filter} onValueChange={(value) => setFilter(value as Filter)} aria-label="Filter worktrees">
          {(Object.keys(FILTERS) as Filter[]).map((value) => (
            <SegmentedControlOption key={value} value={value}>
              {FILTERS[value].label}
            </SegmentedControlOption>
          ))}
        </SegmentedControl>
        <div className="relative min-w-44 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input className="h-8 pl-8 text-sm" placeholder="Search worktrees" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search worktrees" />
        </div>
      </div>
      {worktrees.isPending ? <p className="py-8 text-center font-mono text-xs text-muted-foreground">Reading worktrees…</p> : null}
      {worktrees.data && visible.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">No worktrees match that filter.</p> : null}
      <div className="flex flex-col divide-y divide-border/60">
        {visible.map((wt) => (
          <WorktreeRow key={wt.id} worktree={wt} projectName={projectName(wt.projectId)} />
        ))}
      </div>
    </div>
  )
}

const MAX_USAGE_ROWS = 6

/** Fleet usage: what each running worktree costs, against what this machine has. */
function UsagePanel(): React.JSX.Element {
  const worktrees = useWorktrees().data ?? []
  const hostSamples = useHostSamples()
  const host = useHost().data
  const latestHost = hostSamples.at(-1)
  const cores = host?.cores ?? latestHost?.cores.length ?? 0
  const hostMemMb = host?.memMb ?? latestHost?.memTotalMb ?? 0

  const live = worktrees.filter((wt) => isLive(wt.environment.state))
  const rows = live.slice(0, MAX_USAGE_ROWS).map((wt) => ({ id: wt.id, name: wt.name, ...serviceResources(wt.environment.services) }))
  const hidden = live.length - rows.length
  const totalCpu = Math.round(rows.reduce((sum, row) => sum + row.cpuPct, 0) * 10) / 10
  const totalMem = rows.reduce((sum, row) => sum + row.memMb, 0)
  const cpuTop = cpuScale([totalCpu, ...rows.map((row) => row.cpuPct)], cores)
  const memTop = memScale(rows.map((row) => row.memMb))

  if (rows.length === 0) {
    return (
      <div className="flex h-full flex-col gap-3 px-3 py-2.5 font-mono">
        <p className="rounded-lg border border-dashed border-border py-6 text-center text-sm text-muted-foreground">Nothing running — start a worktree and its usage lands here.</p>
        <FramedBox title="cpu" annotation={`${cores} cores · host`} className="bg-card">
          <div className="px-3 pt-1 pb-3">
            <CoreGrid cores={latestHost?.cores ?? []} />
          </div>
        </FramedBox>
        <FramedBox title="mem" annotation={hostMemMb > 0 ? `host ${formatMem(hostMemMb)}` : 'host'} className="bg-card">
          <div className="px-3 pt-1 pb-3">
            <SystemMemBar parts={[]} host={latestHost} hostMemMb={hostMemMb} label="worktrees" />
          </div>
        </FramedBox>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 px-3 py-2.5 font-mono">
      <FramedBox title="cpu" annotation={`${cores} cores · host`} className="bg-card">
        <div className="flex flex-col gap-1.5 px-3 pt-1 pb-3">
          <div className="flex items-center gap-2 text-xs">
            <span className="w-36 shrink-0 truncate font-medium">CPU</span>
            <Meter fraction={totalCpu / cpuTop} className="flex-1" />
            <span className="w-12 shrink-0 text-right tabular-nums">{totalCpu}%</span>
          </div>
          {rows.map((row, index) => (
            <div key={row.id} className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="w-36 shrink-0 truncate" title={row.name}>
                {row.name}
              </span>
              <Meter fraction={row.cpuPct / cpuTop} slot={((index % 6) + 1) as MeterSlot} className="flex-1" />
              <span className="w-12 shrink-0 text-right tabular-nums">{row.cpuPct}%</span>
            </div>
          ))}
          <div className="mt-1.5 border-t border-border/60 pt-2">
            <CoreGrid cores={latestHost?.cores ?? []} />
          </div>
        </div>
      </FramedBox>
      <FramedBox title="mem" annotation={`${formatMem(totalMem)}${hostMemMb > 0 ? ` of ${formatMem(hostMemMb)}` : ''}`} className="bg-card">
        <div className="flex flex-col gap-1.5 px-3 pt-1 pb-3">
          {rows.map((row, index) => (
            <div key={row.id} className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="w-36 shrink-0 truncate" title={row.name}>
                {row.name}
              </span>
              <Meter fraction={row.memMb / memTop} slot={((index % 6) + 1) as MeterSlot} className="flex-1" />
              <span className="w-16 shrink-0 text-right tabular-nums">{formatMem(row.memMb)}</span>
            </div>
          ))}
          <div className="mt-1.5 border-t border-border/60 pt-2">
            <SystemMemBar parts={rows} host={latestHost} hostMemMb={hostMemMb} label="worktrees" />
          </div>
        </div>
      </FramedBox>
      {hidden > 0 ? <p className="text-[10px] text-muted-foreground">{plural(hidden, 'more running worktree')} not shown — open one for its own breakdown.</p> : null}
    </div>
  )
}

function buildCommandCenterLayout(): AppShellLayout {
  let layout = createAppShellLayout({ initialPaneId: 'pane-usage', views: ['usage'], openDocks: [] })
  layout = splitPane(layout, { paneId: 'pane-usage', direction: PaneSplitDirection.Down, newPaneId: 'pane-worktrees', views: ['worktrees'] })
  layout = setSplitWeights(layout, { splitId: 'split:pane-worktrees', weights: [0.42, 0.58] })
  return layout
}

const PANELS: PanelDef[] = [
  { id: 'worktrees', title: 'Worktrees', icon: ListTree, render: () => <WorktreesPanel /> },
  { id: 'usage', title: 'Usage', icon: Activity, render: () => <UsagePanel /> }
]

export function CommandCenterScreen(): React.JSX.Element {
  const projects = useProjects()
  const [resetToken, setResetToken] = useState(0)

  if (projects.data?.length === 0) {
    return (
      <div className="mx-auto flex w-full max-w-md flex-col items-center gap-3 px-6 py-24 text-center">
        <FolderGit2 className="size-8 text-muted-foreground" />
        <h1 className="text-lg font-semibold tracking-tight">No projects yet</h1>
        <p className="text-sm text-muted-foreground">Add a git repository from the sidebar. Every worktree of that repo gets its own dashboard: diffs, history, and the agent that worked on it.</p>
      </div>
    )
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-7xl flex-col gap-3 px-6 py-5">
      <div className="flex items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Command Center</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">Every worktree on this daemon, what it's running, and what it costs.</p>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={() => setResetToken((token) => token + 1)}>
              <LayoutPanelLeft className="size-3.5" />
              Reset layout
            </Button>
          </TooltipTrigger>
          <TooltipContent>Panels resize from their separators and move by dragging their grips — this puts everything back.</TooltipContent>
        </Tooltip>
      </div>
      <PanelShell storageKey="canopy-cc-layout-v5" buildDefaultLayout={buildCommandCenterLayout} panels={PANELS} resetToken={resetToken} className="min-h-0 flex-1" />
    </div>
  )
}
