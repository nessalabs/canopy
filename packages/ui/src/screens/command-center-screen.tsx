import { useMemo, useState } from 'react'
import { Activity, ArrowDown, ArrowUp, FolderGit2, GitBranch, GitMerge, ListTree, Play, Square, X } from 'lucide-react'
import { Link, useLocation } from 'wouter'

import { environmentDot, formatMem, isLive, serviceResources, type PullRequestSummary, type Worktree } from '@canopy/shared'

import { CHECK_ICON, REVIEW_LABEL, STATE_LOOK } from '@/components/git/pull-request/parts'
import { MergedMark } from '@/components/merged-mark'
import { PanelShell, type PanelDef } from '@/components/panel-shell'
import { CoreGrid, SystemMemBar } from '@/components/resources/host-usage'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { FramedBox } from '@/components/ui/framed-box'
import { Meter, type MeterSlot } from '@/components/ui/meter'
import { StatusDot } from '@/components/ui/status-dot'
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableFilterSelect,
  TableHead,
  TableHeader,
  TableRow,
  TableSearchField,
  TableShell,
  TableSortButton,
  TableToolbar,
  type TableFilterOption,
  type TableSortDirection
} from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { prKey, useHost, useProjectPullRequests, useProjects, useWorktreeLifecycle, useWorktrees } from '@/lib/api-hooks'
import { PaneSplitDirection, createAppShellLayout, setSplitWeights, splitPane, type AppShellLayout } from '@/lib/app-shell-layout'
import { cpuScale, gitHref, memScale, type GitLink } from '@/lib/environment-ui'
import { useHostSamples } from '@/lib/events-provider'
import { plural, relativeTime } from '@/lib/format'
import { ENV_STATE_BADGE, SERVICE_DOT, SERVICE_LABEL, WORKTREE_BADGE, WORKTREE_DOT } from '@/lib/status'
import { cn } from '@/lib/utils'

/** What the table knows about one worktree beyond the worktree itself. */
interface Row {
  worktree: Worktree
  projectName: string
  pr: PullRequestSummary | undefined
  /** GitHub answered for this project, so a missing PR means the branch has none. */
  prKnown: boolean
}

/**
 * Three filters, each about one thing: which repository, what the environment is doing, and
 * where the branch stands. They combine, and each menu counts what the other two leave.
 */
type ProjectFilter = string
type EnvFilter = 'any' | 'running' | 'attention' | 'stopped'
type BranchFilter = 'any' | 'changes' | 'review' | 'no-pr' | 'merged'

const ENV_FILTERS: Record<EnvFilter, { label: string; matches: (row: Row) => boolean }> = {
  any: { label: 'Any environment', matches: () => true },
  running: { label: 'Running', matches: ({ worktree }) => isLive(worktree.environment.state) },
  attention: { label: 'Needs attention', matches: ({ worktree }) => worktree.environment.state === 'degraded' || worktree.environment.state === 'error' },
  stopped: { label: 'Stopped', matches: ({ worktree }) => worktree.environment.state === 'stopped' || worktree.environment.state === 'none' }
}

/** A branch has landed when git says so locally or GitHub merged its PR. */
const isMerged = ({ worktree, pr }: Row): boolean => worktree.status?.merged === true || pr?.state === 'MERGED'

const BRANCH_FILTERS: Record<BranchFilter, { label: string; matches: (row: Row) => boolean }> = {
  any: { label: 'Any branch', matches: () => true },
  changes: { label: 'Uncommitted changes', matches: ({ worktree }) => (worktree.status?.dirtyTotal ?? 0) > 0 },
  review: { label: 'PR open', matches: ({ pr }) => pr?.state === 'OPEN' },
  'no-pr': { label: 'No PR yet', matches: (row) => !row.worktree.isMain && row.prKnown && !row.pr && !isMerged(row) },
  merged: { label: 'Merged', matches: isMerged }
}

type SortKey = 'name' | 'usage' | 'updated'
interface Sort {
  key: SortKey
  direction: TableSortDirection
}

const SORT_VALUE: Record<SortKey, (row: Row) => number | string> = {
  name: ({ worktree }) => worktree.name,
  usage: ({ worktree }) => serviceResources(worktree.environment.services).memMb,
  updated: ({ worktree }) => worktree.status?.lastCommit?.at ?? 0
}

/** The ports a worktree occupies: the allocation map when it has one, else whatever its services publish. */
function portsOf(worktree: Worktree): number[] {
  const allocated = Object.values(worktree.environment.ports)
  if (allocated.length > 0) return allocated
  return worktree.environment.services.filter((service) => !service.excluded).flatMap((service) => service.ports.map((port) => port.port))
}

function compareBy({ key, direction }: Sort): (a: Row, b: Row) => number {
  const value = SORT_VALUE[key]
  const sign = direction === 'ascending' ? 1 : -1
  return (a, b) => {
    const [x, y] = [value(a), value(b)]
    return sign * (typeof x === 'string' && typeof y === 'string' ? x.localeCompare(y) : Number(x) - Number(y))
  }
}

const Dash = (): React.JSX.Element => <span className="text-muted-foreground/50">—</span>
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

/** The branch's PR as a chip: state colour, number, and CI. Clicking it opens the worktree's Pull request pane. */
function PullRequestChip({ pr, worktreeId }: { pr: PullRequestSummary; worktreeId: string }): React.JSX.Element {
  const [, navigate] = useLocation()
  const look = STATE_LOOK[pr.state === 'OPEN' && pr.draft ? 'DRAFT' : pr.state]
  const check = pr.state === 'OPEN' && pr.checks ? CHECK_ICON[pr.checks] : null
  const review = pr.state === 'OPEN' && pr.reviewDecision ? REVIEW_LABEL[pr.reviewDecision] : null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn('inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-1.5 font-mono text-[10px] font-medium tabular-nums', look.className)}
          aria-label={`${look.label} pull request #${pr.number}`}
          onClick={(event) => {
            event.stopPropagation()
            navigate(gitHref(worktreeId, { pane: 'pr' }))
          }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <look.Icon className="size-3" />#{pr.number}
          {check ? <check.Icon className="size-3" /> : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-72">
        <div className="flex flex-col gap-0.5 py-0.5">
          <span className="font-medium">{pr.title}</span>
          <span className="text-muted-foreground">
            {look.label} · into {pr.baseBranch}
            {review ? ` · ${review}` : ''}
            {pr.state === 'OPEN' && pr.checks ? ` · checks ${pr.checks === 'pass' ? 'passed' : pr.checks === 'fail' ? 'failing' : 'running'}` : ''}
          </span>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

/** Status of the checkout: the environment's lifecycle once it has one, else the git state. */
function StatusBadge({ worktree }: { worktree: Worktree }): React.JSX.Element {
  const env = worktree.environment
  const git = WORKTREE_BADGE[worktree.state]
  const badge = env.state === 'none' ? git : ENV_STATE_BADGE[env.state]
  return (
    <Badge variant={badge.variant} className="w-24 justify-center text-[10px]">
      {badge.label}
    </Badge>
  )
}

/** The PR column: the chip, "none" when GitHub says there is none, a dash when it could not say. */
function PullRequestCell({ row }: { row: Row }): React.JSX.Element {
  if (row.worktree.isMain) return <span className="text-[11px] text-muted-foreground">main checkout</span>
  if (row.pr) return <PullRequestChip pr={row.pr} worktreeId={row.worktree.id} />
  if (row.prKnown && row.worktree.branch) return <span className="text-[11px] text-muted-foreground/70">none</span>
  return <Dash />
}

/**
 * A cell's value that opens the worktree's Git tab where that value comes from. A button, not a
 * nested link: the row itself already opens the worktree, so this stops the row's click.
 */
function GitCellLink({ worktreeId, link, label, className, children, ...props }: { worktreeId: string; link: GitLink; label: string; className?: string; children: React.ReactNode } & Omit<React.ComponentProps<'button'>, 'onClick'>): React.JSX.Element {
  const [, navigate] = useLocation()
  return (
    <button
      type="button"
      aria-label={label}
      className={cn('-mx-1 inline-flex max-w-full items-center rounded px-1 py-0.5 outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:[outline-style:solid] focus-visible:outline-2 focus-visible:outline-ring', className)}
      onClick={(event) => {
        event.stopPropagation()
        navigate(gitHref(worktreeId, link))
      }}
      onKeyDown={(event) => event.stopPropagation()}
      {...props}
    >
      {children}
    </button>
  )
}

/** Where the branch stands against its base: landed, how far it has drifted, and what is not committed. */
function BranchCell({ row }: { row: Row }): React.JSX.Element {
  const { worktree, pr } = row
  const status = worktree.status
  if (worktree.isMain || !status) return <Dash />
  const ahead = status.ahead ?? 0
  const behind = status.behind ?? 0
  // A merged PR chip already says it; this is for branches that landed without one.
  const mergedLocally = status.merged === true && pr?.state !== 'MERGED'
  const dirty = status.dirtyTotal
  if (!mergedLocally && ahead === 0 && behind === 0 && dirty === 0) return <span className="text-[11px] text-muted-foreground/70">even</span>
  const vsBase: GitLink = { pane: 'changes', against: 'base' }
  return (
    <span className="flex items-center gap-1.5 font-mono text-[11px] tabular-nums text-muted-foreground">
      {mergedLocally ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <GitCellLink worktreeId={worktree.id} link={vsBase} label={`Merged into ${worktree.baseBranch}: show the changes`} className="gap-1 font-sans font-medium text-violet-600 dark:text-violet-400">
              <GitMerge className="size-3" />
              merged
            </GitCellLink>
          </TooltipTrigger>
          <TooltipContent side="bottom">Every commit on this branch is already in {worktree.baseBranch}</TooltipContent>
        </Tooltip>
      ) : null}
      {ahead > 0 || behind > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <GitCellLink worktreeId={worktree.id} link={vsBase} label={`${ahead} ahead, ${behind} behind ${worktree.baseBranch}: show the changes`} className="gap-1.5">
              <span className={cn('inline-flex items-center', ahead === 0 && 'opacity-40')}>
                <ArrowUp className="size-3" />
                {ahead}
              </span>
              <span className={cn('inline-flex items-center', behind === 0 && 'opacity-40')}>
                <ArrowDown className="size-3" />
                {behind}
              </span>
            </GitCellLink>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {plural(ahead, 'commit')} ahead of {worktree.baseBranch}, {behind} behind — click for the diff vs {worktree.baseBranch}
          </TooltipContent>
        </Tooltip>
      ) : null}
      {dirty > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <GitCellLink worktreeId={worktree.id} link={{ pane: 'changes', against: 'head' }} label={`${plural(dirty, 'uncommitted change')}: show them`} className="gap-1 text-amber-600 dark:text-amber-500">
              <span className="size-1.5 rounded-full bg-current" />
              {dirty}
            </GitCellLink>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {status.staged} staged · {status.unstaged} unstaged · {status.untracked} untracked — click to review
          </TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  )
}

const MAX_PORTS = 2

function PortsCell({ worktree }: { worktree: Worktree }): React.JSX.Element {
  const ports = portsOf(worktree)
  if (ports.length === 0) return <Dash />
  const extra = ports.length - MAX_PORTS
  return (
    <span className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
      {ports.slice(0, MAX_PORTS).map((port) => (
        <span key={port} className="rounded border border-border px-1 py-px">
          :{port}
        </span>
      ))}
      {extra > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="px-0.5">+{extra}</span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="font-mono">
            {ports.map((port) => `:${port}`).join('  ')}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  )
}

function WorktreeRow({ row }: { row: Row }): React.JSX.Element {
  const [, navigate] = useLocation()
  const { worktree, projectName } = row
  const env = worktree.environment
  const status = worktree.status
  const resources = serviceResources(env.services)
  const href = `/worktrees/${worktree.id}`

  return (
    <TableRow className="group cursor-pointer" onClick={() => navigate(href)}>
      <TableCell className="w-8 pr-0">
        <HealthDot worktree={worktree} />
      </TableCell>
      <TableCell className="max-w-72">
        <div className="flex min-w-0 flex-col">
          <Link
            href={href}
            className="truncate font-mono text-[13px] font-medium outline-none hover:underline focus-visible:underline"
            title={worktree.name}
            onClick={(event) => event.stopPropagation()}
          >
            {worktree.name}
          </Link>
          <span className="flex min-w-0 items-center gap-1 font-mono text-[11px] text-muted-foreground" title={worktree.branch ?? 'detached'}>
            <GitBranch className="size-3 shrink-0" />
            <span className="truncate">{worktree.branch ?? 'detached'}</span>
            <MergedMark worktree={worktree} side="bottom" className="size-3" />
          </span>
        </div>
      </TableCell>
      <TableCell className="text-[12px] text-muted-foreground">{projectName}</TableCell>
      <TableCell>
        <StatusBadge worktree={worktree} />
      </TableCell>
      <TableCell>
        <PullRequestCell row={row} />
      </TableCell>
      <TableCell>
        <BranchCell row={row} />
      </TableCell>
      <TableCell>
        <PortsCell worktree={worktree} />
      </TableCell>
      <TableCell className="text-right font-mono text-[11px] tabular-nums text-muted-foreground">
        {resources.processes > 0 ? `${resources.cpuPct}% · ${formatMem(resources.memMb)}` : <Dash />}
      </TableCell>
      <TableCell className="w-full max-w-0">
        {status?.lastCommit ? (
          <GitCellLink
            worktreeId={worktree.id}
            link={{ pane: 'history', commit: status.lastCommit.sha }}
            label={`Show commit ${status.lastCommit.shortSha} in History`}
            title={`${status.lastCommit.shortSha} ${status.lastCommit.subject} — ${status.lastCommit.author}`}
            className="text-[12px] text-muted-foreground"
          >
            <span className="min-w-0 truncate">{status.lastCommit.subject}</span>
          </GitCellLink>
        ) : (
          <Dash />
        )}
      </TableCell>
      <TableCell className="text-right text-[11px] tabular-nums text-muted-foreground">
        {status?.lastCommit ? (
          <GitCellLink worktreeId={worktree.id} link={{ pane: 'history', commit: status.lastCommit.sha }} label={`Show commit ${status.lastCommit.shortSha} in History`} title={new Date(status.lastCommit.at).toLocaleString()}>
            {relativeTime(status.lastCommit.at)}
          </GitCellLink>
        ) : (
          <Dash />
        )}
      </TableCell>
      <TableCell className="w-10 pl-0 text-right">
        {env.state === 'stopped' || env.state === 'error' ? (
          <LifecycleButton worktree={worktree} action="start">
            <Play className="size-3.5" />
          </LifecycleButton>
        ) : isLive(env.state) ? (
          <LifecycleButton worktree={worktree} action="stop">
            <Square className="size-3.5" />
          </LifecycleButton>
        ) : null}
      </TableCell>
    </TableRow>
  )
}

const COLUMNS = 11

function SortableHead({ label, sortKey, sort, onSort, className }: { label: string; sortKey: SortKey; sort: Sort | null; onSort: (key: SortKey) => void; className?: string }): React.JSX.Element {
  const direction = sort?.key === sortKey ? sort.direction : undefined
  return (
    <TableHead aria-sort={direction ?? 'none'} className={className}>
      <TableSortButton direction={direction} onClick={() => onSort(sortKey)}>
        {label}
      </TableSortButton>
    </TableHead>
  )
}

/** Options with counts, the "any" option first. */
function options<K extends string>(filters: Record<K, { label: string }>, count: (key: K) => number): TableFilterOption[] {
  return (Object.keys(filters) as K[]).map((key, index) => ({ value: key, label: filters[key].label, count: index === 0 ? undefined : count(key) }))
}

function WorktreesPanel(): React.JSX.Element {
  const worktrees = useWorktrees()
  const projects = useProjects().data ?? []
  const [project, setProject] = useState<ProjectFilter>('all')
  const [envFilter, setEnvFilter] = useState<EnvFilter>('any')
  const [branchFilter, setBranchFilter] = useState<BranchFilter>('any')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort | null>(null)
  const pullRequests = useProjectPullRequests(useMemo(() => projects.map((p) => p.id), [projects]))

  const rows = useMemo<Row[]>(() => {
    const names = new Map(projects.map((p) => [p.id, p.name]))
    return (worktrees.data ?? []).map((worktree) => ({
      worktree,
      projectName: names.get(worktree.projectId) ?? '',
      pr: worktree.branch && !worktree.isMain ? pullRequests.byBranch.get(prKey(worktree.projectId, worktree.branch)) : undefined,
      prKnown: pullRequests.known.has(worktree.projectId)
    }))
  }, [worktrees.data, projects, pullRequests])

  // Each facet is tested on its own, so a menu can count what the other two leave.
  const needle = query.trim().toLowerCase()
  const bySearch = (row: Row): boolean => !needle || `${row.worktree.name} ${row.worktree.branch ?? ''} ${row.projectName} ${row.pr ? `#${row.pr.number} ${row.pr.title}` : ''}`.toLowerCase().includes(needle)
  const byProject = (row: Row, value = project): boolean => value === 'all' || row.worktree.projectId === value
  const byEnv = (row: Row, value = envFilter): boolean => ENV_FILTERS[value].matches(row)
  const byBranch = (row: Row, value = branchFilter): boolean => BRANCH_FILTERS[value].matches(row)
  const searched = rows.filter(bySearch)
  const countWhere = (test: (row: Row) => boolean): number => searched.filter(test).length

  const kept = searched.filter((row) => byProject(row) && byEnv(row) && byBranch(row))
  const visible = sort ? [...kept].sort(compareBy(sort)) : kept

  const projectOptions: TableFilterOption[] = [
    { value: 'all', label: 'All projects' },
    ...projects.map((p) => ({ value: p.id, label: p.name, count: countWhere((row) => byProject(row, p.id) && byEnv(row) && byBranch(row)) }))
  ]
  const envOptions = options(ENV_FILTERS, (key) => countWhere((row) => byProject(row) && byEnv(row, key) && byBranch(row)))
  const branchOptions = options(BRANCH_FILTERS, (key) => countWhere((row) => byProject(row) && byEnv(row) && byBranch(row, key)))
  const filtered = project !== 'all' || envFilter !== 'any' || branchFilter !== 'any' || needle !== ''

  // Text sorts start A→Z, numbers start largest first; a third click goes back to the daemon's order.
  const onSort = (key: SortKey): void =>
    setSort((current) => {
      const first: TableSortDirection = key === 'name' ? 'ascending' : 'descending'
      if (current?.key !== key) return { key, direction: first }
      if (current.direction === first) return { key, direction: first === 'ascending' ? 'descending' : 'ascending' }
      return null
    })

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 px-3 py-2.5">
      <TableToolbar>
        <TableSearchField className="w-56" placeholder="Search name, branch or PR" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search worktrees" />
        {projects.length > 1 ? <TableFilterSelect label="Project" options={projectOptions} value={project} onValueChange={setProject} /> : null}
        <TableFilterSelect label="Environment" options={envOptions} value={envFilter} onValueChange={(value) => setEnvFilter(value as EnvFilter)} />
        <TableFilterSelect label="Branch" options={branchOptions} value={branchFilter} onValueChange={(value) => setBranchFilter(value as BranchFilter)} />
        {filtered ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1 text-muted-foreground"
            onClick={() => {
              setProject('all')
              setEnvFilter('any')
              setBranchFilter('any')
              setQuery('')
            }}
          >
            <X className="size-3.5" />
            Clear
          </Button>
        ) : null}
        <span className="ml-auto font-mono text-[11px] tabular-nums text-muted-foreground">
          {filtered ? `${visible.length} of ${plural(rows.length, 'worktree')}` : plural(rows.length, 'worktree')}
        </span>
      </TableToolbar>
      <TableShell className="min-h-0 flex-1">
        <Table containerClassName="min-h-0 flex-1 scroll-pt-9" containerLabel="Worktrees">
          <TableHeader sticky>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-8 pr-0">
                <span className="sr-only">Health</span>
              </TableHead>
              <SortableHead label="Worktree" sortKey="name" sort={sort} onSort={onSort} />
              <TableHead>Project</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Pull request</TableHead>
              <TableHead>vs base</TableHead>
              <TableHead>Ports</TableHead>
              <SortableHead label="CPU · mem" sortKey="usage" sort={sort} onSort={onSort} className="text-right" />
              <TableHead>Last commit</TableHead>
              <SortableHead label="Updated" sortKey="updated" sort={sort} onSort={onSort} className="text-right" />
              <TableHead className="w-10 pl-0">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {worktrees.isPending ? <TableEmpty colSpan={COLUMNS}>Reading worktrees…</TableEmpty> : null}
            {worktrees.data && visible.length === 0 ? <TableEmpty colSpan={COLUMNS}>No worktrees match these filters.</TableEmpty> : null}
            {visible.map((row) => (
              <WorktreeRow key={row.worktree.id} row={row} />
            ))}
          </TableBody>
        </Table>
      </TableShell>
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

/** Worktrees take the width and the height; usage sits in a column on the right. */
function buildCommandCenterLayout(): AppShellLayout {
  let layout = createAppShellLayout({ initialPaneId: 'pane-worktrees', views: ['worktrees'], openDocks: [] })
  layout = splitPane(layout, { paneId: 'pane-worktrees', direction: PaneSplitDirection.Right, newPaneId: 'pane-usage', views: ['usage'] })
  layout = setSplitWeights(layout, { splitId: 'split:pane-usage', weights: [0.76, 0.24] })
  return layout
}

const PANELS: PanelDef[] = [
  { id: 'worktrees', title: 'Worktrees', icon: ListTree, render: () => <WorktreesPanel /> },
  { id: 'usage', title: 'Usage', icon: Activity, render: () => <UsagePanel /> }
]

export function CommandCenterScreen(): React.JSX.Element {
  const projects = useProjects()

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
    <div className="mx-auto flex h-full w-full max-w-[120rem] flex-col gap-3 px-6 py-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Command Center</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">Every worktree on this daemon, what it's running, and what it costs.</p>
      </div>
      <PanelShell storageKey="canopy-cc-layout-v7" buildDefaultLayout={buildCommandCenterLayout} panels={PANELS} className="min-h-0 flex-1" />
    </div>
  )
}
