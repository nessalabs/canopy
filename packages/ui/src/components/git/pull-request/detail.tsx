import { useEffect, useState } from 'react'
import { Download, GitMerge, GitPullRequestDraft, MessageSquareText, MoreHorizontal, RotateCw, Send, Upload, Users } from 'lucide-react'

import type { ChangedFile, DiffSpec, PullRequest, PullRequestAction, PullRequestResponse, ReviewComment, Worktree } from '@canopy/shared'

import { ErrorNote } from '@/components/error-note'
import { SplitView, SplitViewOrientation, SplitViewPanel, SplitViewSeparator } from '@/components/split-view'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { SegmentedControl, SegmentedControlOption } from '@/components/ui/segmented-control'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useCommitAllAndPush, useDiffFiles, useFetchPullRequest, usePullRequestAction, usePushBranch } from '@/lib/api-hooks'
import { absoluteTime, plural, relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'

import { CommitDetail } from '../commit-detail'
import { CommitList } from '../commit-list'
import { DiffExplorer, type ExplorerFocus } from '../diff-explorer'
import { MergePullRequestDialog, ReviewDialog, postableComments } from './dialogs'
import { SidePicker } from './pickers'
import { CHECK_ICON, Empty, GitHubAvatar, MERGE_STATE, Markdown, REVIEW_LABEL, REVIEWER_LOOK, TONE_CLASS, VERDICT_LABEL, at, checksSummary, stateLook, useExternalLink, type ReviewProps } from './parts'

type View = 'overview' | 'commits' | 'files'

const WORKING_TREE: DiffSpec = { kind: 'worktree', against: 'head' }

/**
 * One PR, reviewed and landed without leaving the Git tab: what it is and where it stands, the
 * local work it does not have yet, its commits, its whole diff, and the actions GitHub offers —
 * review, comment, merge, ready, close.
 */
export function PullRequestDetail({
  worktree,
  data,
  pr,
  review,
  githubComments,
  focus,
  refreshing,
  onRefresh,
  onOpenChanges
}: {
  worktree: Worktree
  data: PullRequestResponse
  pr: PullRequest
  review: ReviewProps
  githubComments: ReviewComment[]
  focus?: ExplorerFocus
  refreshing: boolean
  onRefresh: () => void
  /** Opens the Changes pane, where files and hunks are picked for a commit. */
  onOpenChanges: () => void
}): React.JSX.Element {
  const [view, setView] = useState<View>('overview')
  // A jump from the Comments pane lands on the file in Files changed.
  useEffect(() => {
    if (focus) setView('files')
  }, [focus])
  const [merging, setMerging] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [notice, setNotice] = useState<string>()
  const action = usePullRequestAction(worktree.id)
  const open = pr.state === 'OPEN'
  const run = (next: Parameters<typeof action.mutate>[0]): void => {
    setNotice(undefined)
    action.mutate(next, { onSuccess: (result) => setNotice(result.message) })
  }

  const actions = (
    <>
      {open && pr.draft ? (
        <Button variant="outline" size="sm" className="h-7 text-xs" disabled={action.isPending} onClick={() => run({ kind: 'ready', ready: true })}>
          Ready for review
        </Button>
      ) : null}
      {open ? (
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setReviewing(true)}>
          <MessageSquareText />
          Review
        </Button>
      ) : null}
      {open ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button size="sm" className="h-7 text-xs" disabled={!data.canMerge} onClick={() => setMerging(true)}>
                <GitMerge />
                {pr.autoMerge ? 'Auto-merge on' : 'Merge'}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{data.canMerge ? (MERGE_STATE[pr.mergeState] ?? MERGE_STATE.UNKNOWN!).hint : 'You do not have permission to merge in this repository.'}</TooltipContent>
        </Tooltip>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-7" aria-label="More pull request actions" disabled={action.isPending}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {open && !pr.draft ? (
            <DropdownMenuItem onSelect={() => run({ kind: 'ready', ready: false })}>
              <GitPullRequestDraft /> Convert to draft
            </DropdownMenuItem>
          ) : null}
          {pr.checks.some((check) => check.outcome === 'fail') ? (
            <DropdownMenuItem onSelect={() => run({ kind: 'rerun' })}>
              <RotateCw /> Re-run failed checks
            </DropdownMenuItem>
          ) : null}
          {open ? <DropdownMenuSeparator /> : null}
          {open ? (
            <DropdownMenuItem variant="destructive" onSelect={() => run({ kind: 'close' })}>
              Close pull request
            </DropdownMenuItem>
          ) : pr.state === 'CLOSED' ? (
            <DropdownMenuItem onSelect={() => run({ kind: 'reopen' })}>Reopen pull request</DropdownMenuItem>
          ) : (
            <DropdownMenuItem disabled>Merged — nothing to do</DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )

  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      <Header pr={pr} host={data.gh.host} refreshing={refreshing} onRefresh={onRefresh} actions={actions}>
        <SegmentedControl value={view} onValueChange={(value) => setView(value as View)} aria-label="Pull request view" className="shrink-0 text-xs">
          <SegmentedControlOption value="overview">Overview</SegmentedControlOption>
          <SegmentedControlOption value="commits">Commits · {pr.commitLog.length}</SegmentedControlOption>
          <SegmentedControlOption value="files">Files · {pr.changedFiles}</SegmentedControlOption>
        </SegmentedControl>
      </Header>

      <div className="flex flex-col gap-2 px-6 pt-3 empty:hidden">
        {action.isPending ? <p className="font-mono text-xs text-muted-foreground">Asking GitHub…</p> : null}
        {notice ? <p className="text-xs text-emerald-600 dark:text-emerald-500">{notice}</p> : null}
        {action.error ? <ErrorNote error={action.error} /> : null}
        {open ? <LocalWork worktree={worktree} pr={pr} data={data} onOpenChanges={onOpenChanges} /> : null}
      </div>

      {view === 'overview' ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <Overview worktreeId={worktree.id} pr={pr} host={data.gh.host} onRun={run} running={action.isPending} />
        </div>
      ) : null}
      {view === 'commits' ? <CommitsView worktreeId={worktree.id} pr={pr} review={review} /> : null}
      {view === 'files' ? <FilesView worktreeId={worktree.id} pr={pr} review={review} githubComments={githubComments} focus={focus} /> : null}

      <MergePullRequestDialog worktreeId={worktree.id} pr={pr} methods={data.mergeMethods} open={merging} onOpenChange={setMerging} onDone={setNotice} />
      <ReviewDialog worktreeId={worktree.id} pr={pr} viewer={data.viewer} comments={review.comments} open={reviewing} onOpenChange={setReviewing} onDone={setNotice} />
    </div>
  )
}

/**
 * The PR in one row: its state, title and who is merging what where, its size, the view switch
 * and the actions GitHub offers. Opening it on GitHub is the top bar's primary action.
 */
function Header({
  pr,
  host,
  refreshing,
  onRefresh,
  actions,
  children
}: {
  pr: PullRequest
  host: string | null
  refreshing: boolean
  onRefresh: () => void
  actions: React.ReactNode
  /** The view switch, placed between the PR's size and its actions. */
  children: React.ReactNode
}): React.JSX.Element {
  const look = stateLook(pr)
  const facts = [
    pr.state === 'OPEN' ? (pr.reviewDecision ? (REVIEW_LABEL[pr.reviewDecision] ?? pr.reviewDecision) : 'No review required') : null,
    pr.state === 'OPEN' ? (pr.mergeable === 'CONFLICTING' ? `Has conflicts with ${pr.baseBranch}` : pr.mergeable === 'MERGEABLE' ? 'No conflicts' : null) : null,
    checksSummary(pr.checks)
  ].filter((fact): fact is string => Boolean(fact))

  return (
    <header className="flex shrink-0 items-center gap-2.5 overflow-hidden border-b border-border py-2 ps-6 pe-3 whitespace-nowrap">
      <Badge className={cn('shrink-0', look.className)}>
        <look.Icon />
        {look.label}
      </Badge>
      <h3 className="min-w-0 shrink truncate text-sm font-semibold">
        {pr.title} <span className="font-normal text-muted-foreground">#{pr.number}</span>
      </h3>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="hidden min-w-0 flex-1 items-center gap-1.5 truncate text-xs text-muted-foreground @5xl:inline-flex">
            <GitHubAvatar login={pr.author} host={host} className="size-4 shrink-0 rounded-full" />
            <span className="truncate">
              <span className="text-foreground">{pr.author}</span> {pr.state === 'MERGED' ? 'merged' : 'wants to merge'} {plural(pr.commits, 'commit')} into{' '}
              <span className="font-mono">{pr.baseBranch}</span> from <span className="font-mono">{pr.headBranch}</span> · updated {relativeTime(at(pr.updatedAt))}
              {facts.map((fact) => ` · ${fact}`).join('')}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {absoluteTime(at(pr.updatedAt))}
          {facts.length ? ` · ${facts.join(' · ')}` : ''}
        </TooltipContent>
      </Tooltip>
      <span className="ms-auto flex shrink-0 items-center gap-2 font-mono text-[11px]">
        <span className="text-emerald-600 dark:text-emerald-500">+{pr.additions}</span>
        <span className="text-destructive">−{pr.deletions}</span>
      </span>
      {children}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label="Refresh" disabled={refreshing} onClick={onRefresh}>
            <RotateCw className={cn(refreshing && 'animate-spin')} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Read it from GitHub again</TooltipContent>
      </Tooltip>
      <span className="flex shrink-0 items-center gap-1.5">{actions}</span>
    </header>
  )
}

/**
 * What this checkout has that the PR does not: uncommitted files (commit them all and push from
 * here, or pick them in Changes), commits not pushed, and commits pushed from elsewhere.
 */
function LocalWork({ worktree, pr, data, onOpenChanges }: { worktree: Worktree; pr: PullRequest; data: PullRequestResponse; onOpenChanges: () => void }): React.JSX.Element | null {
  const changes = useDiffFiles(worktree.id, WORKING_TREE)
  const files: ChangedFile[] = changes.data && 'files' in changes.data ? changes.data.files : []
  const push = usePushBranch(worktree.id)
  const fetch = useFetchPullRequest(worktree.id)
  const commit = useCommitAllAndPush(worktree.id)
  const [summary, setSummary] = useState('')
  const unpushed = data.upstream?.ahead ?? 0
  const behind = data.upstream?.behind ?? 0
  const conflicted = files.some((file) => file.conflicted)

  if (files.length === 0 && unpushed === 0 && pr.missingCommits.length === 0 && behind === 0) return null
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
      {files.length ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="flex-1 text-sm">
              {plural(files.length, 'uncommitted change')} here, not in the pull request yet
            </span>
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onOpenChanges}>
              Pick files in Changes
            </Button>
          </div>
          <ul className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
            {files.slice(0, 8).map((file) => (
              <li key={file.path}>
                {file.status} {file.path}
              </li>
            ))}
            {files.length > 8 ? <li>… {files.length - 8} more</li> : null}
          </ul>
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (!summary.trim()) return
              commit.mutate({ paths: files.map((file) => file.path), summary: summary.trim() }, { onSuccess: () => setSummary('') })
            }}
          >
            <Input className="h-8 flex-1 text-sm" placeholder="Commit message" aria-label="Commit message" value={summary} disabled={commit.isPending} onChange={(event) => setSummary(event.target.value)} />
            <Button type="submit" size="sm" className="h-8" disabled={commit.isPending || conflicted || summary.trim() === ''}>
              {commit.isPending ? <RotateCw className="animate-spin" /> : <Send />}
              {commit.isPending ? 'Committing…' : 'Commit all and push'}
            </Button>
          </form>
          {conflicted ? <p className="text-xs text-destructive">Resolve the conflicts in Changes first.</p> : null}
          <ErrorNote error={commit.error} />
        </div>
      ) : null}
      {unpushed > 0 ? (
        <div className="flex items-center gap-3">
          <span className="flex-1 text-sm">{plural(unpushed, 'local commit')} not on GitHub yet — the pull request does not include {unpushed === 1 ? 'it' : 'them'}.</span>
          <Button size="sm" className="h-7" disabled={push.isPending} onClick={() => push.mutate()}>
            {push.isPending ? <RotateCw className="animate-spin" /> : <Upload />}
            {push.isPending ? 'Pushing…' : 'Push'}
          </Button>
        </div>
      ) : null}
      <ErrorNote error={push.error} />
      {pr.missingCommits.length ? (
        <div className="flex items-center gap-3">
          <span className="flex-1 text-sm">
            {plural(pr.missingCommits.length, 'commit')} in the pull request {pr.missingCommits.length === 1 ? 'is' : 'are'} not in this checkout. Fetch to read {pr.missingCommits.length === 1 ? 'its' : 'their'}{' '}
            diff; no branch moves.
          </span>
          <FetchButton pending={fetch.isPending} onFetch={() => fetch.mutate()} />
        </div>
      ) : behind > 0 ? (
        <p className="text-sm">
          {plural(behind, 'commit')} on GitHub {behind === 1 ? 'is' : 'are'} not on this branch yet. Pull before committing here, or the push will be refused.
        </p>
      ) : null}
      <ErrorNote error={fetch.error} />
    </section>
  )
}

/** Brings the PR's commits into this checkout — a fetch only, no branch moves. */
function FetchButton({ pending, onFetch }: { pending: boolean; onFetch: () => void }): React.JSX.Element {
  return (
    <Button size="sm" variant="outline" className="h-7" disabled={pending} onClick={onFetch}>
      {pending ? <RotateCw className="animate-spin" /> : <Download />}
      {pending ? 'Fetching…' : 'Fetch'}
    </Button>
  )
}

/** A diff that waits on commits this checkout lacks, with the fetch that brings them right there. */
function NeedsFetch({ worktreeId, children }: { worktreeId: string; children: React.ReactNode }): React.JSX.Element {
  const fetch = useFetchPullRequest(worktreeId)
  return (
    <div className="flex flex-col items-start gap-2 p-4">
      <p className="text-sm text-muted-foreground">{children}</p>
      <FetchButton pending={fetch.isPending} onFetch={() => fetch.mutate()} />
      <ErrorNote error={fetch.error} />
    </div>
  )
}

function Overview({ worktreeId, pr, host, onRun, running }: { worktreeId: string; pr: PullRequest; host: string | null; onRun: (action: PullRequestAction) => void; running: boolean }): React.JSX.Element {
  const open = useExternalLink()
  const state = MERGE_STATE[pr.mergeState] ?? MERGE_STATE.UNKNOWN!
  const failing = pr.checks.some((check) => check.outcome === 'fail')
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="grid gap-6 pr-3 pb-6 lg:grid-cols-[minmax(0,1fr)_15rem]">
        <div className="flex min-w-0 flex-col gap-5">
          <section className="rounded-lg border border-border p-4">{pr.body.trim() ? <Markdown>{pr.body}</Markdown> : <p className="text-sm text-muted-foreground italic">No description.</p>}</section>

          <Conversation pr={pr} host={host} />
          <section className="flex flex-col gap-2 rounded-lg border border-border p-3">
            <div className="flex items-center gap-2">
              <h4 className="flex-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Checks · {checksSummary(pr.checks)}
              </h4>
              {failing ? (
                <Button variant="ghost" size="sm" className="h-7 text-xs" disabled={running} onClick={() => onRun({ kind: 'rerun' })}>
                  <RotateCw /> Re-run failed
                </Button>
              ) : null}
            </div>
            {pr.checks.length ? (
              <ul className="flex flex-col overflow-hidden rounded-md border border-border">
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
            ) : (
              <p className="text-xs text-muted-foreground">No CI runs on this pull request.</p>
            )}
            {pr.state === 'OPEN' ? <p className={cn('text-xs', TONE_CLASS[state.tone])}>{pr.autoMerge ? 'Auto-merge is on: GitHub merges this once its requirements pass.' : state.hint}</p> : null}
          </section>

          {pr.state !== 'MERGED' ? <CommentBox key={pr.number} onComment={(body) => onRun({ kind: 'comment', body })} running={running} /> : null}
        </div>
        <People worktreeId={worktreeId} pr={pr} host={host} onRun={onRun} running={running} />
      </div>
    </div>
  )
}

function Conversation({ pr, host }: { pr: PullRequest; host: string | null }): React.JSX.Element | null {
  if (pr.events.length === 0) return null
  return (
    <section className="flex flex-col gap-3">
      <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Conversation</h4>
      {pr.events.map((event, index) => (
        <article key={`${event.at}:${index}`} className="flex gap-3">
          <GitHubAvatar login={event.author} host={host} className="mt-0.5 size-6 shrink-0 rounded-full" />
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
  )
}

function CommentBox({ onComment, running }: { onComment: (body: string) => void; running: boolean }): React.JSX.Element {
  const [body, setBody] = useState('')
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (!body.trim()) return
        onComment(body)
        setBody('')
      }}
    >
      <Textarea className="min-h-20 text-sm" placeholder="Add a comment (Markdown)" aria-label="Add a comment" value={body} disabled={running} onChange={(event) => setBody(event.target.value)} />
      <Button type="submit" size="sm" variant="outline" className="w-fit self-end" disabled={running || body.trim() === ''}>
        Comment
      </Button>
    </form>
  )
}

function Side({ title, picker, children }: { title: string; picker?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2 border-b border-border/60 pb-4 last:border-b-0">
      <div className="flex items-center gap-1">
        <h4 className="flex-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h4>
        {picker}
      </div>
      {children}
    </section>
  )
}

const None = ({ children }: { children: React.ReactNode }): React.JSX.Element => <p className="text-xs text-muted-foreground">{children}</p>

/** GitHub's sidebar: who reviews, who owns it, how it is filed — each editable in place. */
function People({ worktreeId, pr, host, onRun, running }: { worktreeId: string; pr: PullRequest; host: string | null; onRun: (action: PullRequestAction) => void; running: boolean }): React.JSX.Element {
  const editable = pr.state === 'OPEN' && !running
  const people = (options: { users: { login: string; name: string | null }[] }) => options.users.map((user) => ({ id: user.login, label: user.login, detail: user.name, avatar: user.login }))
  const requested = pr.reviewers.filter((reviewer) => reviewer.state === 'requested').map((reviewer) => reviewer.name)
  return (
    <aside className="flex flex-col gap-4 text-sm">
      <Side
        title="Reviewers"
        picker={
          <SidePicker
            worktreeId={worktreeId}
            host={host}
            title="Reviewers"
            choices={(options) => people(options).filter((choice) => choice.id !== pr.author)}
            selected={requested}
            allowCustom={(query) => (query.includes('/') ? { id: query, label: query, detail: 'team' } : null)}
            onCommit={(add, remove) => onRun({ kind: 'reviewers', add, remove })}
            disabled={!editable}
          />
        }
      >
        {pr.reviewers.length ? (
          <ul className="flex flex-col gap-2">
            {pr.reviewers.map((reviewer) => {
              const look = REVIEWER_LOOK[reviewer.state]
              return (
                <li key={`${reviewer.team ? 'team' : 'user'}:${reviewer.name}`} className="flex items-center gap-2">
                  {reviewer.team ? (
                    <Users className="size-5 shrink-0 rounded-full bg-muted p-0.5 text-muted-foreground" />
                  ) : (
                    <GitHubAvatar login={reviewer.name} host={host} className="size-5 shrink-0 rounded-full" />
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
      <Side
        title="Assignees"
        picker={<SidePicker worktreeId={worktreeId} host={host} title="Assignees" choices={people} selected={pr.assignees.map((person) => person.login)} onCommit={(add, remove) => onRun({ kind: 'assignees', add, remove })} disabled={!editable} />}
      >
        {pr.assignees.length ? (
          <ul className="flex flex-col gap-2">
            {pr.assignees.map((person) => (
              <li key={person.login} className="flex items-center gap-2">
                <GitHubAvatar login={person.login} name={person.name} host={host} className="size-5 shrink-0 rounded-full" />
                <span className="min-w-0 truncate">{person.login}</span>
                {person.name ? <span className="min-w-0 truncate text-xs text-muted-foreground">{person.name}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <None>No one assigned</None>
        )}
      </Side>
      <Side
        title="Labels"
        picker={
          <SidePicker
            worktreeId={worktreeId}
            host={host}
            title="Labels"
            choices={(options) => options.labels.map((label) => ({ id: label.name, label: label.name, color: label.color }))}
            selected={pr.labels.map((label) => label.name)}
            onCommit={(add, remove) => onRun({ kind: 'labels', add, remove })}
            disabled={!editable}
          />
        }
      >
        {pr.labels.length ? (
          <div className="flex flex-wrap gap-1.5">
            {pr.labels.map((label) => (
              <span key={label.name} className="rounded-full border px-2 py-0.5 text-xs" style={{ borderColor: `#${label.color}`, backgroundColor: `#${label.color}26` }}>
                {label.name}
              </span>
            ))}
          </div>
        ) : (
          <None>None yet</None>
        )}
      </Side>
      <Side
        title="Milestone"
        picker={
          <SidePicker
            worktreeId={worktreeId}
            host={host}
            title="Milestone"
            single
            choices={(options) => options.milestones.map((title) => ({ id: title, label: title }))}
            selected={pr.milestone ? [pr.milestone] : []}
            onCommit={(add) => onRun({ kind: 'milestone', milestone: add[0] ?? null })}
            disabled={!editable}
          />
        }
      >
        {pr.milestone ? <span>{pr.milestone}</span> : <None>No milestone</None>}
      </Side>
    </aside>
  )
}

/**
 * The History tab's layout for just this PR: its commits on the left, the chosen one's files and
 * diff on the right, with the same comments and review sending.
 */
function CommitsView({ worktreeId, pr, review }: { worktreeId: string; pr: PullRequest; review: ReviewProps }): React.JSX.Element {
  // Newest first, as History lists them.
  const commits = [...pr.commitLog].reverse()
  const [selected, setSelected] = useState<string>()
  const current = commits.some((commit) => commit.sha === selected) ? selected : commits[0]?.sha
  const missing = new Set(pr.missingCommits)

  if (commits.length === 0) return <Empty>No commits in this pull request.</Empty>
  return (
    <div className="min-h-0 flex-1 overflow-hidden">
      <SplitView orientation={SplitViewOrientation.Horizontal} className="h-full">
        <SplitViewPanel id="pr-commits" defaultSize={32} minSize={20} className="min-h-0 border-r border-border bg-card">
          <CommitList commits={commits} selected={current} onSelect={setSelected} hasMore={false} loadingMore={false} onLoadMore={() => undefined} />
        </SplitViewPanel>
        <SplitViewSeparator />
        <SplitViewPanel id="pr-commit-detail" minSize={40} className="min-h-0">
          {current && missing.has(current) ? (
            <NeedsFetch worktreeId={worktreeId}>This commit is not in this checkout yet. Fetch the pull request to read its diff.</NeedsFetch>
          ) : current ? (
            <CommitDetail worktreeId={worktreeId} sha={current} {...review} />
          ) : null}
        </SplitViewPanel>
      </SplitView>
    </div>
  )
}

/**
 * GitHub's Files changed: the PR head against its merge base with the target. Line comments left
 * here are ordinary local comments — send them to an agent, or post them with a GitHub review.
 */
function FilesView({ worktreeId, pr, review, githubComments, focus }: { worktreeId: string; pr: PullRequest; review: ReviewProps; githubComments: ReviewComment[]; focus?: ExplorerFocus }): React.JSX.Element {
  const range = pr.filesRange
  const spec: DiffSpec = range ? { kind: 'trees', before: range.before, after: range.after } : WORKING_TREE
  const diff = useDiffFiles(worktreeId, spec)
  if (!range) return <NeedsFetch worktreeId={worktreeId}>This checkout does not have the pull request’s head or its target yet. Fetch the pull request to read its diff.</NeedsFetch>
  if (diff.isPending) return <p className="p-4 font-mono text-xs text-muted-foreground">Reading the diff…</p>
  if (diff.error) return <ErrorNote error={diff.error} />
  const files: ChangedFile[] = diff.data && 'files' in diff.data ? diff.data.files : []
  const comments = postableComments(review.comments, pr)
  // GitHub's threads sit on their lines beside the local comments; they count as sent, so the
  // toolbar's unsent tally and the review dialog leave them alone.
  const shown = [...comments, ...githubComments]
  return <DiffExplorer worktreeId={worktreeId} spec={spec} files={files} comments={shown} mode={review.mode} focus={focus} className="min-h-0 flex-1 overflow-hidden" />
}
