import { useMemo, useState } from 'react'
import { Activity, FolderGit2, GitBranch, LayoutPanelLeft, ListTree, Search } from 'lucide-react'
import { useLocation } from 'wouter'

import type { Worktree, WorktreeState } from '@canopy/shared'

import { ComingSoon } from '@/components/coming-soon'
import { PanelShell, type PanelDef } from '@/components/panel-shell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SegmentedControl, SegmentedControlOption } from '@/components/ui/segmented-control'
import { StatusDot } from '@/components/ui/status-dot'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useProjects, useWorktrees } from '@/lib/api-hooks'
import { PaneSplitDirection, createAppShellLayout, setSplitWeights, splitPane, type AppShellLayout } from '@/lib/app-shell-layout'
import { plural, relativeTime } from '@/lib/format'
import { WORKTREE_BADGE, WORKTREE_DOT } from '@/lib/status'

type Filter = 'all' | 'dirty' | 'clean'

const FILTERS: Record<Filter, { label: string; states: WorktreeState[] }> = {
  all: { label: 'All', states: ['clean', 'dirty', 'detached', 'missing'] },
  dirty: { label: 'Changes', states: ['dirty'] },
  clean: { label: 'Clean', states: ['clean', 'detached'] }
}

function WorktreeRow({ worktree, projectName }: { worktree: Worktree; projectName: string }): React.JSX.Element {
  const [, navigate] = useLocation()
  const badge = WORKTREE_BADGE[worktree.state]
  const status = worktree.status
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
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex size-5 shrink-0 items-center justify-center">
            <StatusDot status={WORKTREE_DOT[worktree.state]} aria-label={`${worktree.name} ${badge.label}`} />
          </span>
        </TooltipTrigger>
        <TooltipContent side="right">
          {status ? `${status.staged} staged · ${status.unstaged} unstaged · ${status.untracked} untracked` : 'Worktree directory is missing'}
        </TooltipContent>
      </Tooltip>
      <span className="flex w-56 min-w-0 flex-col">
        <span className="truncate font-mono text-sm font-medium">{worktree.name}</span>
        <span className="flex items-center gap-1 truncate font-mono text-[10px] text-muted-foreground">
          <GitBranch className="size-2.5 shrink-0" />
          {projectName} · {worktree.branch ?? 'detached'}
        </span>
      </span>
      <Badge variant={badge.variant} className="hidden w-24 justify-center text-[10px] sm:inline-flex">
        {worktree.state === 'dirty' && status ? plural(status.dirtyTotal, 'change') : badge.label}
      </Badge>
      {worktree.isMain ? (
        <Badge variant="outline" className="text-[10px]">
          main checkout
        </Badge>
      ) : null}
      {status?.ahead !== null && status?.ahead !== undefined ? (
        <span className="hidden font-mono text-[11px] tabular-nums text-muted-foreground lg:inline">
          ↑{status.ahead} ↓{status.behind}
        </span>
      ) : null}
      <span className="ml-auto flex items-center gap-3">
        {status?.lastCommit ? (
          <span className="hidden max-w-64 truncate text-[11px] text-muted-foreground xl:inline" title={status.lastCommit.subject}>
            {status.lastCommit.subject}
          </span>
        ) : null}
        {status?.lastCommit ? <span className="hidden w-20 text-right text-[10px] text-muted-foreground sm:inline">{relativeTime(status.lastCommit.at)}</span> : null}
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
      (wt) => FILTERS[filter].states.includes(wt.state) && (!needle || `${wt.name} ${wt.branch ?? ''} ${projectName(wt.projectId)}`.toLowerCase().includes(needle))
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

function buildCommandCenterLayout(): AppShellLayout {
  let layout = createAppShellLayout({ initialPaneId: 'pane-usage', views: ['usage'], openDocks: [] })
  layout = splitPane(layout, { paneId: 'pane-usage', direction: PaneSplitDirection.Down, newPaneId: 'pane-worktrees', views: ['worktrees'] })
  layout = setSplitWeights(layout, { splitId: 'split:pane-worktrees', weights: [0.3, 0.7] })
  return layout
}

const PANELS: PanelDef[] = [
  { id: 'worktrees', title: 'Worktrees', icon: ListTree, render: () => <WorktreesPanel /> },
  {
    id: 'usage',
    title: 'Usage',
    icon: Activity,
    render: () => <ComingSoon title="Host usage" detail="Per-worktree CPU and memory arrive with the Environment tab, once Canopy supervises services." />
  }
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
          <p className="mt-0.5 text-sm text-muted-foreground">Every worktree this daemon knows about, and where each one stands.</p>
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
      <PanelShell storageKey="canopy-cc-layout-v4" buildDefaultLayout={buildCommandCenterLayout} panels={PANELS} resetToken={resetToken} className="min-h-0 flex-1" />
    </div>
  )
}
