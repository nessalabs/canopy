import { useEffect, useState } from 'react'
import { ChevronsUpDown, CircleCheck, CircleDashed, CircleMinus, CircleX, Download, ExternalLink, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, GitMerge, MessageSquare, RotateCw, Upload, Users } from 'lucide-react'
import { Popover } from 'radix-ui'

import type { GhStatus, PullRequest, PullRequestCheck, PullRequestResponse, PullRequestReviewer, ReviewComment, UpstreamStatus, Worktree } from '@canopy/shared'

import { ErrorNote } from '@/components/error-note'
import { SplitView, SplitViewOrientation, SplitViewPanel, SplitViewSeparator } from '@/components/split-view'
import type { DiffMode } from '@/components/worktree-diff'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { CopyButton } from '@/components/ui/code-block'
import { Input } from '@/components/ui/input'
import { MessageMarkdown } from '@/components/ui/message-markdown'
import { PopoverSurface } from '@/components/ui/popover-surface'
import { RandomAvatar } from '@/components/ui/random-avatar'
import { SearchableListbox } from '@/components/ui/searchable-listbox'
import { SegmentedControl, SegmentedControlOption } from '@/components/ui/segmented-control'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useCreatePullRequest, useFetchPullRequest, usePullRequest, usePushBranch } from '@/lib/api-hooks'
import { absoluteTime, plural, relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { usePlatform } from '@/providers/platform'

import { CommitDetail } from './commit-detail'
import { CommitList } from './commit-list'

/**
 * The Git tab's Pull request pane: the branch's PR on GitHub, or a form to open one. GitHub is
 * reached through the GitHub CLI on the daemon's machine, so when that is not set up the pane
 * says what to run there instead.
 */
/** What a commit's diff needs from the Git tab: its comments, its view mode, and review sending. */
export interface ReviewProps {
  comments: ReviewComment[]
  mode: DiffMode
  onModeChange: (mode: DiffMode) => void
  onSendForReview: () => void
  sending: boolean
}

export function PullRequestView({ worktree, review }: { worktree: Worktree; review: ReviewProps }): React.JSX.Element {
  const query = usePullRequest(worktree.id)
  const data = query.data

  if (query.isPending) return <Loading />
  if (query.error || !data) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-border py-10">
        <ErrorNote error={query.error ?? new Error('No answer from the daemon.')} />
        <Button variant="outline" size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>
          <RotateCw className={cn(query.isFetching && 'animate-spin')} />
          Try again
        </Button>
      </div>
    )
  }
  if (data.gh.state !== 'ready') return <GhSetup status={data.gh} checking={query.isFetching} onCheck={() => void query.refetch()} />
  if (!data.branch) return <Empty>This worktree is on a detached HEAD. Check out a branch to open a pull request from it.</Empty>
  if (data.pr) return <PullRequestDetail worktree={worktree} pr={data.pr} upstream={data.upstream} review={review} refreshing={query.isFetching} onRefresh={() => void query.refetch()} />
  if (data.branch === data.baseBranch) {
    return (
      <Empty>
        This checkout is on <span className="font-mono text-foreground">{data.branch}</span>, the base branch. Pull requests are opened from the worktrees cut from it.
      </Empty>
    )
  }
  return <CreatePullRequest worktree={worktree} data={data} />
}

/** The PR page's outline while GitHub answers, so the pane lands at once and fills in. */
function Loading(): React.JSX.Element {
  const bar = 'animate-pulse rounded bg-muted'
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5" aria-busy="true" aria-label="Reading the pull request from GitHub">
      <div className="flex flex-col gap-2">
        <div className={cn(bar, 'h-5 w-2/3')} />
        <div className={cn(bar, 'h-3 w-1/2')} />
        <div className={cn(bar, 'h-3 w-1/3')} />
      </div>
      <div className={cn(bar, 'h-24 w-full rounded-lg')} />
      <div className={cn(bar, 'h-32 w-full rounded-lg')} />
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="rounded-xl border border-border px-6 py-10 text-center text-sm text-muted-foreground">{children}</div>
}

/** Links in PR text leave the app: in the desktop shell a plain click would replace the window. */
function useExternalLink() {
  const { openExternal } = usePlatform()
  return (url: string) => (event: React.MouseEvent) => {
    event.preventDefault()
    openExternal(url)
  }
}

function Markdown({ children }: { children: string }): React.JSX.Element {
  const open = useExternalLink()
  return (
    <MessageMarkdown
      className="text-sm"
      components={{
        a: ({ href, children: label }) => (
          <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2" onClick={href ? open(href) : undefined}>
            {label}
          </a>
        )
      }}
    >
      {children}
    </MessageMarkdown>
  )
}

// ---- setup ----

interface Step {
  label: string
  command?: string
  link?: string
}

function setupFor(status: GhStatus): { title: string; description: string; steps: Step[] } {
  const host = status.host ?? 'github.com'
  const login = host === 'github.com' ? 'gh auth login' : `gh auth login --hostname ${host}`
  switch (status.state) {
    case 'missing':
      return {
        title: 'Install the GitHub CLI',
        description: 'Canopy reads and opens pull requests with the GitHub CLI (gh), on the machine running the Canopy daemon. It is not installed there yet.',
        steps: [
          { label: 'Install it (macOS, with Homebrew)', command: 'brew install gh' },
          { label: 'Other systems: see the install page', link: 'https://cli.github.com' },
          { label: 'Sign in to GitHub', command: login }
        ]
      }
    case 'unauthenticated':
      return {
        title: `Sign in to ${host}`,
        description: 'The GitHub CLI is installed but not signed in, so Canopy cannot read this repository’s pull requests.',
        steps: [{ label: 'Sign in, in a terminal on the daemon’s machine', command: login }]
      }
    case 'not-github':
      return {
        title: 'This remote is not on GitHub',
        description: `The branch pushes to ${status.remoteUrl ?? 'a remote'}, which is not a GitHub host Canopy knows. Pull requests here work with GitHub remotes only.`,
        steps: status.host ? [{ label: 'If it is GitHub Enterprise, sign in to that host', command: `gh auth login --hostname ${status.host}` }] : []
      }
    case 'no-remote':
      return {
        title: 'No remote yet',
        description: 'This repository has no remote, so there is nowhere to open a pull request.',
        steps: [
          { label: 'Create a GitHub repository for it and push', command: 'gh repo create --source . --push' },
          { label: 'Or point it at an existing one', command: 'git remote add origin <url>' }
        ]
      }
    default:
      return { title: 'GitHub is ready', description: '', steps: [] }
  }
}

function GhSetup({ status, checking, onCheck }: { status: GhStatus; checking: boolean; onCheck: () => void }): React.JSX.Element {
  const { title, description, steps } = setupFor(status)
  const open = useExternalLink()
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 rounded-xl border border-border p-6">
      <div className="flex flex-col gap-1">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <GitPullRequest className="size-4 text-muted-foreground" />
          {title}
        </h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {steps.length ? (
        <ol className="flex flex-col gap-3">
          {steps.map((step, index) => (
            <li key={step.label} className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">
                {index + 1}. {step.label}
              </span>
              {step.command ? (
                <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 py-1.5 pr-1.5 pl-3">
                  <code className="min-w-0 flex-1 truncate font-mono text-xs">{step.command}</code>
                  <CopyButton text={step.command} label={`Copy ${step.command}`} />
                </div>
              ) : null}
              {step.link ? (
                <a href={step.link} target="_blank" rel="noreferrer" onClick={open(step.link)} className="flex w-fit items-center gap-1 font-mono text-xs text-primary underline-offset-2 hover:underline">
                  {step.link}
                  <ExternalLink className="size-3" />
                </a>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {status.detail ? <p className="font-mono text-[11px] text-muted-foreground">gh: {status.detail}</p> : null}
      <Button variant="outline" size="sm" className="w-fit" disabled={checking} onClick={onCheck}>
        <RotateCw className={cn(checking && 'animate-spin')} />
        {checking ? 'Checking…' : 'Check again'}
      </Button>
    </div>
  )
}

// ---- an existing PR ----

const STATE_LOOK: Record<string, { label: string; Icon: React.ComponentType<{ className?: string }>; className: string }> = {
  OPEN: { label: 'Open', Icon: GitPullRequest, className: 'border-transparent bg-emerald-600 text-white' },
  DRAFT: { label: 'Draft', Icon: GitPullRequestDraft, className: 'border-transparent bg-muted text-muted-foreground' },
  MERGED: { label: 'Merged', Icon: GitMerge, className: 'border-transparent bg-violet-600 text-white' },
  CLOSED: { label: 'Closed', Icon: GitPullRequestClosed, className: 'border-transparent bg-destructive text-destructive-foreground' }
}

const REVIEW_LABEL: Record<string, string> = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', REVIEW_REQUIRED: 'Review required' }
const VERDICT_LABEL: Record<string, string> = { APPROVED: 'approved', CHANGES_REQUESTED: 'requested changes', COMMENTED: 'reviewed', DISMISSED: 'review dismissed' }

const CHECK_ICON: Record<PullRequestCheck['outcome'], { Icon: React.ComponentType<{ className?: string }>; className: string }> = {
  pass: { Icon: CircleCheck, className: 'text-emerald-600 dark:text-emerald-500' },
  fail: { Icon: CircleX, className: 'text-destructive' },
  pending: { Icon: CircleDashed, className: 'text-amber-600 dark:text-amber-500' },
  skipped: { Icon: CircleMinus, className: 'text-muted-foreground' },
  neutral: { Icon: CircleMinus, className: 'text-muted-foreground' }
}

const at = (iso: string): number => Date.parse(iso)

function checksSummary(checks: PullRequestCheck[]): string {
  if (checks.length === 0) return 'No checks'
  const failed = checks.filter((c) => c.outcome === 'fail').length
  const pending = checks.filter((c) => c.outcome === 'pending').length
  if (failed) return `${plural(failed, 'check')} failing`
  if (pending) return `${plural(pending, 'check')} running`
  return `${plural(checks.length, 'check')} passed`
}

function PullRequestDetail({
  worktree,
  pr,
  upstream,
  review,
  refreshing,
  onRefresh
}: {
  worktree: Worktree
  pr: PullRequest
  upstream: UpstreamStatus | null
  review: ReviewProps
  refreshing: boolean
  onRefresh: () => void
}): React.JSX.Element {
  const open = useExternalLink()
  const push = usePushBranch(worktree.id)
  const look = STATE_LOOK[pr.state === 'OPEN' && pr.draft ? 'DRAFT' : pr.state]!
  const unpushed = upstream?.ahead ?? 0
  const [view, setView] = useState<'overview' | 'commits'>('overview')
  const facts = [
    pr.state === 'OPEN' ? (pr.reviewDecision ? REVIEW_LABEL[pr.reviewDecision] ?? pr.reviewDecision : 'No review required') : null,
    pr.state === 'OPEN' ? (pr.mergeable === 'CONFLICTING' ? 'Has conflicts with ' + pr.baseBranch : pr.mergeable === 'MERGEABLE' ? 'No conflicts' : null) : null,
    checksSummary(pr.checks)
  ].filter((fact): fact is string => Boolean(fact))

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
        <header className="flex flex-col gap-2">
          <div className="flex items-start gap-3">
            <h3 className="min-w-0 flex-1 text-base font-medium">
              {pr.title} <span className="font-normal text-muted-foreground">#{pr.number}</span>
            </h3>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label="Refresh" disabled={refreshing} onClick={onRefresh}>
                  <RotateCw className={cn(refreshing && 'animate-spin')} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Read it from GitHub again</TooltipContent>
            </Tooltip>
            <Button variant="outline" size="sm" className="h-8 shrink-0" asChild>
              <a href={pr.url} target="_blank" rel="noreferrer" onClick={open(pr.url)}>
                <ExternalLink />
                Open on GitHub
              </a>
            </Button>
          </div>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <Badge className={look.className}>
              <look.Icon />
              {look.label}
            </Badge>
            <span>
              <span className="text-foreground">{pr.author}</span> {pr.state === 'MERGED' ? 'merged' : 'wants to merge'} {plural(pr.commits, 'commit')} into{' '}
              <span className="font-mono">{pr.baseBranch}</span> from <span className="font-mono">{pr.headBranch}</span>
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>· updated {relativeTime(at(pr.updatedAt))}</span>
              </TooltipTrigger>
              <TooltipContent>{absoluteTime(at(pr.updatedAt))}</TooltipContent>
            </Tooltip>
          </p>
          <p className="flex flex-wrap items-center gap-x-3 font-mono text-[11px] text-muted-foreground">
            <span className="text-emerald-600 dark:text-emerald-500">+{pr.additions}</span>
            <span className="text-destructive">−{pr.deletions}</span>
            <span>{plural(pr.changedFiles, 'file')}</span>
            {facts.map((fact) => (
              <span key={fact}>· {fact}</span>
            ))}
          </p>
        </header>

        {unpushed > 0 && pr.state === 'OPEN' ? (
          <div className="flex items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
            <span className="flex-1 text-sm">{plural(unpushed, 'local commit')} not on GitHub yet — the pull request does not include {unpushed === 1 ? 'it' : 'them'}.</span>
            <Button size="sm" disabled={push.isPending} onClick={() => push.mutate()}>
              {push.isPending ? <RotateCw className="animate-spin" /> : <Upload />}
              {push.isPending ? 'Pushing…' : 'Push'}
            </Button>
          </div>
        ) : null}
        <ErrorNote error={push.error} />

        <SegmentedControl value={view} onValueChange={(value) => setView(value as 'overview' | 'commits')} aria-label="Pull request view" className="w-fit">
          <SegmentedControlOption value="overview">Overview</SegmentedControlOption>
          <SegmentedControlOption value="commits">Commits · {pr.commitLog.length}</SegmentedControlOption>
        </SegmentedControl>

        {view === 'commits' ? (
          <PullRequestCommits worktreeId={worktree.id} pr={pr} review={review} />
        ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid gap-6 pb-6 lg:grid-cols-[minmax(0,1fr)_15rem]">
        <div className="flex min-w-0 flex-col gap-5">
        {pr.checks.length ? (
          <section className="flex flex-col gap-1.5">
            <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Checks</h4>
            <ul className="flex flex-col overflow-hidden rounded-lg border border-border">
              {pr.checks.map((check, index) => {
                const { Icon, className } = CHECK_ICON[check.outcome]
                return (
                  <li key={`${check.workflow}:${check.name}:${index}`} className="flex items-center gap-2.5 border-b border-border/60 px-3 py-1.5 text-sm last:border-b-0">
                    <Icon className={cn('size-4 shrink-0', className)} />
                    <span className="min-w-0 flex-1 truncate">
                      {check.workflow ? <span className="text-muted-foreground">{check.workflow} / </span> : null}
                      {check.name}
                    </span>
                    {check.url ? (
                      <a href={check.url} target="_blank" rel="noreferrer" onClick={open(check.url)} className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                        Details
                      </a>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </section>
        ) : null}

        <section className="rounded-lg border border-border p-4">{pr.body.trim() ? <Markdown>{pr.body}</Markdown> : <p className="text-sm text-muted-foreground italic">No description.</p>}</section>

        {pr.events.length ? (
          <section className="flex flex-col gap-3">
            <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Conversation</h4>
            {pr.events.map((event, index) => (
              <article key={`${event.at}:${index}`} className="flex gap-3">
                <RandomAvatar seed={event.author} name={event.author} className="mt-0.5 size-6 shrink-0 rounded-full" />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{event.author}</span>
                    {event.verdict ? <span>{VERDICT_LABEL[event.verdict] ?? event.verdict.toLowerCase()}</span> : <span>commented</span>}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span>· {relativeTime(at(event.at))}</span>
                      </TooltipTrigger>
                      <TooltipContent>{absoluteTime(at(event.at))}</TooltipContent>
                    </Tooltip>
                  </p>
                  {event.body.trim() ? (
                    <div className="rounded-lg border border-border px-3 py-2">
                      <Markdown>{event.body}</Markdown>
                    </div>
                  ) : null}
                </div>
              </article>
            ))}
          </section>
        ) : null}
        </div>
        <People pr={pr} />
        </div>
        </div>
        )}
    </div>
  )
}

const REVIEWER_LOOK: Record<PullRequestReviewer['state'], { label: string; Icon: React.ComponentType<{ className?: string }>; className: string }> = {
  requested: { label: 'Awaiting review', Icon: CircleDashed, className: 'text-amber-600 dark:text-amber-500' },
  PENDING: { label: 'Review in progress', Icon: CircleDashed, className: 'text-amber-600 dark:text-amber-500' },
  APPROVED: { label: 'Approved', Icon: CircleCheck, className: 'text-emerald-600 dark:text-emerald-500' },
  CHANGES_REQUESTED: { label: 'Requested changes', Icon: CircleX, className: 'text-destructive' },
  COMMENTED: { label: 'Commented', Icon: MessageSquare, className: 'text-muted-foreground' },
  DISMISSED: { label: 'Review dismissed', Icon: CircleMinus, className: 'text-muted-foreground' }
}

function Side({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2 border-b border-border/60 pb-4 last:border-b-0">
      <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h4>
      {children}
    </section>
  )
}

const None = ({ children }: { children: React.ReactNode }): React.JSX.Element => <p className="text-xs text-muted-foreground">{children}</p>

/** GitHub's sidebar: who reviews, who owns it, how it is filed. */
function People({ pr }: { pr: PullRequest }): React.JSX.Element {
  return (
    <aside className="flex flex-col gap-4 text-sm">
      <Side title="Reviewers">
        {pr.reviewers.length ? (
          <ul className="flex flex-col gap-2">
            {pr.reviewers.map((reviewer) => {
              const look = REVIEWER_LOOK[reviewer.state]
              return (
                <li key={`${reviewer.team ? 'team' : 'user'}:${reviewer.name}`} className="flex items-center gap-2">
                  {reviewer.team ? (
                    <Users className="size-5 shrink-0 rounded-full bg-muted p-0.5 text-muted-foreground" />
                  ) : (
                    <RandomAvatar seed={reviewer.name} name={reviewer.name} className="size-5 shrink-0 rounded-full" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{reviewer.name}</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <look.Icon className={cn('size-4 shrink-0', look.className)} aria-label={look.label} />
                    </TooltipTrigger>
                    <TooltipContent>{look.label}</TooltipContent>
                  </Tooltip>
                </li>
              )
            })}
          </ul>
        ) : (
          <None>No reviews requested</None>
        )}
      </Side>
      <Side title="Assignees">
        {pr.assignees.length ? (
          <ul className="flex flex-col gap-2">
            {pr.assignees.map((person) => (
              <li key={person.login} className="flex items-center gap-2">
                <RandomAvatar seed={person.login} name={person.name ?? person.login} className="size-5 shrink-0 rounded-full" />
                <span className="min-w-0 truncate">{person.login}</span>
                {person.name ? <span className="min-w-0 truncate text-xs text-muted-foreground">{person.name}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <None>No one assigned</None>
        )}
      </Side>
      <Side title="Labels">
        {pr.labels.length ? (
          <div className="flex flex-wrap gap-1.5">
            {pr.labels.map((label) => (
              <span
                key={label.name}
                className="rounded-full border px-2 py-0.5 text-xs"
                style={{ borderColor: `#${label.color}`, backgroundColor: `#${label.color}26` }}
              >
                {label.name}
              </span>
            ))}
          </div>
        ) : (
          <None>None yet</None>
        )}
      </Side>
      <Side title="Milestone">{pr.milestone ? <span>{pr.milestone}</span> : <None>No milestone</None>}</Side>
    </aside>
  )
}

/**
 * The History tab's layout for just this PR: its commits on the left, the chosen one's files and
 * diff on the right, with the same comments and review sending. A commit pushed from somewhere
 * else is listed but has no diff here until it is fetched.
 */
function PullRequestCommits({ worktreeId, pr, review }: { worktreeId: string; pr: PullRequest; review: ReviewProps }): React.JSX.Element {
  // Newest first, as History lists them.
  const commits = [...pr.commitLog].reverse()
  const [selected, setSelected] = useState<string>()
  const current = commits.some((commit) => commit.sha === selected) ? selected : commits[0]?.sha
  const missing = new Set(pr.missingCommits)
  const fetch = useFetchPullRequest(worktreeId)

  if (commits.length === 0) return <Empty>No commits in this pull request.</Empty>
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {missing.size ? (
        <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2">
          <span className="flex-1 text-sm">
            {plural(missing.size, 'commit')} {missing.size === 1 ? 'is' : 'are'} on GitHub but not in this checkout. Fetch {missing.size === 1 ? 'it' : 'them'} to see the diff — no branch
            changes.
          </span>
          <Button size="sm" variant="outline" disabled={fetch.isPending} onClick={() => fetch.mutate()}>
            {fetch.isPending ? <RotateCw className="animate-spin" /> : <Download />}
            {fetch.isPending ? 'Fetching…' : 'Fetch'}
          </Button>
        </div>
      ) : null}
      <ErrorNote error={fetch.error} />
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border">
        <SplitView orientation={SplitViewOrientation.Horizontal} className="h-full">
          <SplitViewPanel id="pr-commits" defaultSize={32} minSize={20} className="min-h-0 border-r border-border bg-card">
            <CommitList commits={commits} selected={current} onSelect={setSelected} hasMore={false} loadingMore={false} onLoadMore={() => undefined} />
          </SplitViewPanel>
          <SplitViewSeparator />
          <SplitViewPanel id="pr-commit-detail" minSize={40} className="min-h-0">
            {current && missing.has(current) ? (
              <p className="p-4 text-sm text-muted-foreground">This commit is not in this checkout yet. Fetch the pull request to see its diff.</p>
            ) : current ? (
              <CommitDetail worktreeId={worktreeId} sha={current} {...review} />
            ) : null}
          </SplitViewPanel>
        </SplitView>
      </div>
    </div>
  )
}

// ---- opening one ----

/** The branches a PR can go into, searchable: a remote can have hundreds. */
function BranchPicker({
  branches,
  value,
  suggested,
  disabled,
  onChange
}: {
  branches: string[]
  value: string
  suggested: string | null
  disabled: boolean
  onChange: (branch: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-8 w-64 justify-between font-mono text-xs" disabled={disabled || branches.length === 0} aria-label="Branch to merge into">
          <span className="truncate">{value || (branches.length ? 'Pick a branch' : 'No remote branches')}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content asChild side="bottom" align="start" sideOffset={6} collisionPadding={8}>
          <PopoverSurface className="w-[min(92vw,22rem)] p-0">
            <SearchableListbox
              items={branches}
              getItemId={(branch) => branch}
              getItemKeywords={(branch) => [branch]}
              renderItem={(branch) => (
                <span className="flex w-full items-center gap-2 font-mono text-xs">
                  <span className="min-w-0 flex-1 truncate">{branch}</span>
                  {branch === suggested ? <span className="shrink-0 font-sans text-[10px] text-muted-foreground">cut from here</span> : null}
                </span>
              )}
              value={value}
              onValueChange={(branch) => {
                onChange(branch)
                setOpen(false)
              }}
              listLabel="Branches on the remote"
              searchPlaceholder="Search branches"
              listClassName="max-h-72"
            />
          </PopoverSurface>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function CreatePullRequest({ worktree, data }: { worktree: Worktree; data: PullRequestResponse }): React.JSX.Element {
  const create = useCreatePullRequest(worktree.id)
  const [title, setTitle] = useState(data.draft?.title ?? '')
  const [body, setBody] = useState(data.draft?.body ?? '')
  const [base, setBase] = useState(data.suggestedBase ?? '')
  const [draft, setDraft] = useState(false)
  const [touched, setTouched] = useState(false)

  // Branches arrive with the read; until someone picks one, the form follows the suggestion.
  const [basePicked, setBasePicked] = useState(false)
  useEffect(() => {
    if (!basePicked && data.suggestedBase) setBase(data.suggestedBase)
  }, [data.suggestedBase])

  // The suggestion follows new commits until someone starts writing their own.
  useEffect(() => {
    if (touched || !data.draft) return
    setTitle(data.draft.title)
    setBody(data.draft.body)
  }, [data.draft?.title, data.draft?.body])

  const ahead = worktree.status?.ahead ?? null
  const dirty = worktree.status?.dirtyTotal ?? 0
  const needsPush = !data.upstream?.name || (data.upstream.ahead ?? 0) > 0
  const nothing = ahead === 0

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <form
        className="mx-auto flex w-full max-w-2xl flex-col gap-4 rounded-xl border border-border p-5"
        onSubmit={(event) => {
          event.preventDefault()
          create.mutate({ title, body, base: base.trim() || undefined, draft })
        }}
      >
        <div className="flex flex-col gap-1">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <GitPullRequest className="size-4 text-muted-foreground" />
            Open a pull request
          </h3>
          <p className="text-sm text-muted-foreground">
            No pull request on GitHub for <span className="font-mono text-foreground">{data.branch}</span> yet.
            {needsPush ? ' The branch is pushed first, so GitHub has every commit.' : ''}
          </p>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-muted-foreground">Title</span>
          <Input
            value={title}
            disabled={create.isPending}
            onChange={(event) => {
              setTouched(true)
              setTitle(event.target.value)
            }}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-muted-foreground">Description (Markdown)</span>
          <Textarea
            className="min-h-40 font-mono text-xs"
            value={body}
            disabled={create.isPending}
            onChange={(event) => {
              setTouched(true)
              setBody(event.target.value)
            }}
          />
        </label>
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">Into</span>
            <BranchPicker
              branches={data.bases}
              value={base}
              suggested={data.suggestedBase}
              disabled={create.isPending}
              onChange={(next) => {
                setBasePicked(true)
                setBase(next)
              }}
            />
          </label>
          <label className="flex h-8 items-center gap-2 text-sm">
            <Checkbox checked={draft} disabled={create.isPending} onChange={(event) => setDraft(event.target.checked)} />
            Open as draft
          </label>
        </div>
        {dirty > 0 ? <p className="text-xs text-amber-600 dark:text-amber-500">{plural(dirty, 'uncommitted change')} here will not be part of it — only commits are pushed.</p> : null}
        {nothing ? <p className="text-xs text-muted-foreground">This branch has no commits that {data.baseBranch} lacks, so there is nothing to open a pull request for yet.</p> : null}
        <ErrorNote error={create.error} />
        <Button type="submit" size="sm" className="w-fit" disabled={create.isPending || nothing || title.trim().length === 0 || !base}>
          {create.isPending ? <RotateCw className="animate-spin" /> : needsPush ? <Upload /> : <GitPullRequest />}
          {create.isPending ? (needsPush ? 'Pushing and opening…' : 'Opening…') : needsPush ? 'Push and open pull request' : 'Open pull request'}
        </Button>
      </form>
    </div>
  )
}
