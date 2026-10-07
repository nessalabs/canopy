import { useEffect, useState } from 'react'
import { ChevronsUpDown, ExternalLink, GitPullRequest, RotateCw, Upload } from 'lucide-react'
import { Popover } from 'radix-ui'

import type { GhStatus, PullRequestResponse, ReviewComment, Worktree } from '@canopy/shared'

import { ErrorNote } from '@/components/error-note'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { CopyButton } from '@/components/ui/code-block'
import { Input } from '@/components/ui/input'
import { PopoverSurface } from '@/components/ui/popover-surface'
import { SearchableListbox } from '@/components/ui/searchable-listbox'
import { Textarea } from '@/components/ui/textarea'
import { useCreatePullRequest, usePullRequest, useRefreshPullRequest } from '@/lib/api-hooks'
import { plural } from '@/lib/format'
import { cn } from '@/lib/utils'

import type { ExplorerFocus } from './diff-explorer'
import { PullRequestDetail } from './pull-request/detail'
import { Empty, useExternalLink, type ReviewProps } from './pull-request/parts'

/**
 * The Git tab's Pull request pane: the branch's PR on GitHub, or a form to open one. GitHub is
 * reached through the GitHub CLI on the daemon's machine, so when that is not set up the pane
 * says what to run there instead.
 */
export function PullRequestView({
  worktree,
  review,
  githubComments = [],
  focus,
  onOpenChanges
}: {
  worktree: Worktree
  review: ReviewProps
  /** GitHub's review threads as comments, shown on their lines in Files changed. */
  githubComments?: ReviewComment[]
  /** A file (and comment) to open in Files changed — a jump from the Comments pane. */
  focus?: ExplorerFocus
  onOpenChanges: () => void
}): React.JSX.Element {
  const query = usePullRequest(worktree.id)
  const refresh = useRefreshPullRequest(worktree.id)
  const data = query.data

  /** Everything short of a PR to show: loading, setup, a reason there is none, or the form to open one. */
  const page = (): React.JSX.Element => {
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
    if (data.gh.state !== 'ready') return <GhSetup status={data.gh} checking={query.isFetching || refresh.isPending} onCheck={() => refresh.mutate()} />
    if (!data.branch) return <Empty>This worktree is on a detached HEAD. Check out a branch to open a pull request from it.</Empty>
    if (data.branch === data.baseBranch) {
      return (
        <Empty>
          This checkout is on <span className="font-mono text-foreground">{data.branch}</span>, the base branch. Pull requests are opened from the worktrees cut from it.
        </Empty>
      )
    }
    return <CreatePullRequest worktree={worktree} data={data} />
  }

  if (data?.pr && data.gh.state === 'ready' && data.branch) {
    return (
      <PullRequestDetail
        worktree={worktree}
        data={data}
        pr={data.pr}
        review={review}
        githubComments={githubComments}
        focus={focus}
        refreshing={query.isFetching || refresh.isPending}
        onRefresh={() => refresh.mutate()}
        onOpenChanges={onOpenChanges}
      />
    )
  }
  // A page of its own, padded off the bar's edges; the PR itself runs edge to edge.
  return <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">{page()}</div>
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
                <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-sunken py-1.5 pr-1.5 pl-3">
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
