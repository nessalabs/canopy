import { useEffect, useState } from 'react'
import { ChevronDown, GitPullRequest, History, MessageSquare, Trash2 } from 'lucide-react'

import { GRAPH_PRESETS, presetSpec, type AgentProvider, type GraphPreset, type GraphScope, type PullRequestChoice } from '@canopy/shared'

import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { SegmentedControl, SegmentedControlOption } from '@/components/ui/segmented-control'
import { plural, relativeTime } from '@/lib/format'
import { graphTitle, scopeLabel } from '@/lib/review-graph'
import type { ReviewGraphState } from '@/lib/use-review-graph'
import { cn } from '@/lib/utils'

const PROVIDER_NAME = { claude: 'Claude', codex: 'Codex' } as const

export type ScopeKind = GraphScope['kind']

/** A contiguous run of commits picked in History, oldest first. */
export interface CommitRange {
  from: string
  to: string
  count: number
  /** The graph on screen when the run was picked: once another is shown, the bar starts from that one's scope. */
  pickedOn?: string
}

/** Which of the worktree's graphs is on screen, and the way to drop the one that is. */
function GraphPicker({ state }: { state: ReviewGraphState }): React.JSX.Element | null {
  const { record, graphs } = state
  if (!record) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 max-w-64 min-w-0 gap-1.5 px-2 text-xs" title="Graphs of this worktree">
          <span className="truncate">{graphTitle(record)}</span>
          <span className="shrink-0 text-muted-foreground">{relativeTime(record.createdAt)}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-96 w-96 overflow-y-auto">
        <DropdownMenuLabel className="text-xs">Graphs of this worktree</DropdownMenuLabel>
        {graphs.map((item) => (
          <DropdownMenuItem key={item.id} onSelect={() => state.pick(item.id)} className={cn('gap-2 text-xs', item.id === record.id && 'bg-accent')}>
            <span className="min-w-0 flex-1 truncate">{graphTitle(item)}</span>
            <span className="shrink-0 text-muted-foreground">{item.result ? plural(item.result.nodes.length, 'node') : 'no answer yet'}</span>
            <span className="shrink-0 text-muted-foreground tabular-nums">{relativeTime(item.createdAt)}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void state.remove(record.id)} className="gap-2 text-xs text-muted-foreground">
          <Trash2 className="size-3.5" />
          Delete this graph
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Which pull request to draw: the branch's own, or one of those asking to merge into it — on a
 * main checkout, every open PR into main.
 */
function PrPicker({ prs, value, onChange, open, onOpenChange }: { prs: PullRequestChoice[]; value?: number; onChange: (number: number) => void; open: boolean; onOpenChange: (open: boolean) => void }): React.JSX.Element {
  const picked = prs.find((pr) => pr.number === value)
  const group = (label: string, rows: PullRequestChoice[]) =>
    rows.length === 0 ? null : (
      <>
        <DropdownMenuLabel className="text-xs">{label}</DropdownMenuLabel>
        {rows.map((pr) => (
          <DropdownMenuItem key={pr.number} onSelect={() => onChange(pr.number)} className={cn('flex-col items-start gap-0 text-xs', pr.number === value && 'bg-accent')}>
            <span className="flex w-full min-w-0 items-baseline gap-1.5">
              <span className="shrink-0 text-muted-foreground tabular-nums">#{pr.number}</span>
              <span className="min-w-0 flex-1 truncate font-medium">{pr.title}</span>
              {pr.draft || pr.state !== 'OPEN' ? <span className="shrink-0 text-muted-foreground lowercase">{pr.draft && pr.state === 'OPEN' ? 'draft' : pr.state}</span> : null}
            </span>
            <span className="w-full truncate text-muted-foreground">
              {pr.headBranch} → {pr.baseBranch} · {pr.author} · {relativeTime(Date.parse(pr.updatedAt))}
            </span>
          </DropdownMenuItem>
        ))}
      </>
    )
  const own = prs.filter((pr) => !pr.incoming)
  const incoming = prs.filter((pr) => pr.incoming)
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-8 max-w-72 min-w-0 gap-1.5 px-2.5 text-xs" title="Which pull request to draw">
          <GitPullRequest className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{picked ? `#${picked.number} ${picked.title}` : 'Pick a pull request'}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-96 w-96 overflow-y-auto">
        {group('From this branch', own)}
        {own.length > 0 && incoming.length > 0 ? <DropdownMenuSeparator /> : null}
        {group('Into this branch', incoming)}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** What the graph is about: one of the presets, each with a line on what it draws. */
function PresetPicker({ value, onChange }: { value: GraphPreset; onChange: (preset: GraphPreset) => void }): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5 px-2.5 text-xs" title="What the graph is about">
          {presetSpec(value).label}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel className="text-xs">Draw the change as…</DropdownMenuLabel>
        {GRAPH_PRESETS.map((preset) => (
          <DropdownMenuItem key={preset.id} onSelect={() => onChange(preset.id)} className={cn('flex-col items-start gap-0 text-xs', preset.id === value && 'bg-accent')}>
            <span className="font-medium">{preset.label}</span>
            <span className="text-muted-foreground">{preset.hint}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The bar over everything: which graph is shown, and how to make a new one — of which change,
 * about what, in whose words, by which agent — plus the way to its chat and how far review has got.
 */
export function GraphBar({
  state,
  range,
  prs,
  ownPr,
  onKind,
  onPickCommits,
  done,
  total,
  stale
}: {
  state: ReviewGraphState
  /** Commits picked in History, for the Commits scope. */
  range?: CommitRange
  /** PRs out of and into the branch, to pick which one the Pull request scope draws; undefined until read. */
  prs?: PullRequestChoice[]
  /** The branch has a PR of its own; drawable even when the list could not be read. */
  ownPr: boolean
  /** Which scope the bar is on, so the PRs are asked for only when they are wanted. */
  onKind?: (kind: ScopeKind) => void
  /** Goes to History to pick commits. */
  onPickCommits: () => void
  done: number
  total: number
  stale: boolean
}): React.JSX.Element {
  const record = state.record
  // A run picked while this graph was on screen is what the bar offers; otherwise it starts from
  // the graph on screen, so viewing a PR graph after drawing a run does not snap back to Commits.
  const fresh = range !== undefined && range.pickedOn === record?.id
  const [kind, setKind] = useState<ScopeKind>(fresh ? 'commits' : (record?.scope.kind ?? (range ? 'commits' : 'uncommitted')))
  useEffect(() => onKind?.(kind), [kind, onKind])
  const run = fresh ? range : record?.scope.kind === 'commits' ? record.scope : range
  const [preset, setPreset] = useState<GraphPreset>(record?.preset ?? 'features')
  const [wording, setWording] = useState('')
  const [provider, setProvider] = useState<AgentProvider | undefined>(undefined)
  const chosen = provider ?? state.providers[0]
  // The PR the graph on screen is of, else the branch's own, else the newest one into it.
  const [prNumber, setPrNumber] = useState<number | undefined>(record?.scope.kind === 'pull-request' ? record.scope.number : undefined)
  const pr = prNumber ?? prs?.[0]?.number
  const [prMenu, setPrMenu] = useState(false)
  // With more than one PR to choose from, choosing the scope is choosing which — once they are read.
  const [wantMenu, setWantMenu] = useState(false)
  useEffect(() => {
    if (!wantMenu || !prs) return
    if (prs.length > 1) setPrMenu(true)
    setWantMenu(false)
  }, [wantMenu, prs])
  const scope: GraphScope | undefined =
    kind === 'commits' ? (run ? { kind, from: run.from, to: run.to } : undefined) : kind === 'pull-request' ? (pr !== undefined ? { kind, number: pr } : ownPr ? { kind } : undefined) : { kind }
  const has = record !== undefined
  return (
    <form
      className="flex flex-col gap-2 border-b border-border px-4 py-2.5"
      onSubmit={(event) => {
        event.preventDefault()
        if (chosen && scope) void state.make({ scope, preset, instructions: wording, provider: chosen })
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <GraphPicker state={state} />
        <SegmentedControl
          value={kind}
          onValueChange={(value) => {
            setKind(value as ScopeKind)
            if (value === 'pull-request') setWantMenu(true)
          }}
          aria-label="Which change to draw"
          className="text-xs"
        >
          <SegmentedControlOption type="button" value="uncommitted">Uncommitted</SegmentedControlOption>
          <SegmentedControlOption type="button" value="branch">Branch</SegmentedControlOption>
          <SegmentedControlOption type="button" value="commits">{run && run === range ? plural(range.count, 'commit') : 'Commits'}</SegmentedControlOption>
          <SegmentedControlOption type="button" value="pull-request" disabled={!ownPr && prs?.length === 0}>
            Pull request
          </SegmentedControlOption>
        </SegmentedControl>
        {kind === 'commits' ? (
          <Button type="button" size="sm" variant="ghost" className="h-8 gap-1.5 text-xs" onClick={onPickCommits} title="Shift-click commits in History to pick a run of them">
            <History className="size-3.5" />
            {range ? 'Change in History' : 'Pick in History…'}
          </Button>
        ) : null}
        {kind === 'pull-request' ? (
          prs && prs.length > 0 ? (
            <PrPicker prs={prs} value={pr} onChange={setPrNumber} open={prMenu} onOpenChange={setPrMenu} />
          ) : !prs ? (
            <span className="text-xs text-muted-foreground">Finding pull requests…</span>
          ) : !ownPr ? (
            <span className="text-xs text-muted-foreground">No pull requests from or into this branch</span>
          ) : null
        ) : null}
        <PresetPicker value={preset} onChange={setPreset} />
        {has ? (
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            {done} of {total} reviewed
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={wording}
          onChange={(event) => setWording(event.target.value)}
          placeholder={`Anything else? For example: ${preset === 'features' ? 'tests with what they test' : 'keep it to two levels'}`}
          aria-label="How to draw the graph"
          className="h-8 min-w-48 flex-1 text-xs"
        />
        {state.providers.length > 1 ? (
          <SegmentedControl value={chosen} onValueChange={(value) => setProvider(value as AgentProvider)} aria-label="Agent that draws the graph" className="text-xs">
            {state.providers.map((name) => (
              <SegmentedControlOption type="button" key={name} value={name}>
                {PROVIDER_NAME[name]}
              </SegmentedControlOption>
            ))}
          </SegmentedControl>
        ) : null}
        <Button type="submit" size="sm" variant={has ? 'outline' : 'default'} disabled={state.running || !chosen || !scope} title={scope ? `Draw ${scopeLabel(scope).toLowerCase()} as ${presetSpec(preset).label.toLowerCase()}` : 'Pick commits in History first'}>
          {state.running ? 'Drawing…' : has ? 'New graph' : 'Make graph'}
        </Button>
        {state.openChat ? (
          <Button type="button" size="sm" variant="ghost" className="gap-1.5" onClick={state.openChat} title="The graph conversation, in the Git Agent: ask it to merge, split or rename nodes">
            <MessageSquare className="size-3.5" />
            Open chat
          </Button>
        ) : null}
      </div>
      {stale && !state.running ? <p className="text-xs text-muted-foreground">The change has moved on since this graph was drawn. It shows the change as it was then; make a new graph to include the new work.</p> : null}
    </form>
  )
}
