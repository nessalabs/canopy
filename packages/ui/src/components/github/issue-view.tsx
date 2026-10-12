import { useMemo } from 'react'
import {
  ArrowRightLeft,
  CircleCheck,
  CircleDot,
  CircleSlash,
  ExternalLink,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Link2,
  Pencil,
  SquareKanban,
  Tag,
  UserRound,
  type LucideIcon
} from 'lucide-react'

import { classifyGitHubLink, linkIssueRefs, repoUrlOf, type IssueKind, type IssueThread, type IssueTimelineItem, type PullRequestState } from '@canopy/shared'

import { ErrorNote } from '@/components/error-note'
import { Button } from '@/components/ui/button'
import { MessageMarkdown } from '@/components/ui/message-markdown'
import { useIssue } from '@/lib/api-hooks'
import { cn } from '@/lib/utils'
import { usePlatform } from '@/providers/platform'

/** What a reader of an issue can do with the links in it: open another one, or read an attachment. */
export interface IssueLinkHandlers {
  onOpenIssue: (number: number) => void
  onOpenAttachment: (url: string) => void
}

/** Open, closed and merged, as GitHub colours them, for issues and PRs alike. */
const STATE: Record<PullRequestState, { label: string; className: string; icon: Record<IssueKind, LucideIcon> }> = {
  OPEN: { label: 'Open', className: 'bg-emerald-600 text-white', icon: { issue: CircleDot, pr: GitPullRequest } },
  CLOSED: { label: 'Closed', className: 'bg-violet-600 text-white', icon: { issue: CircleCheck, pr: GitPullRequestClosed } },
  MERGED: { label: 'Merged', className: 'bg-violet-600 text-white', icon: { issue: GitMerge, pr: GitMerge } }
}

export function IssueStateBadge({ state, kind, className }: { state: PullRequestState; kind: IssueKind; className?: string }): React.JSX.Element {
  const { label, className: tint, icon } = STATE[state]
  const Icon = icon[kind]
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium', tint, className)}>
      <Icon aria-hidden="true" className="size-3.5" />
      {label}
    </span>
  )
}

/** The glyph on the timeline's rail for each kind of event; anything else gets a plain dot. */
const EVENT_ICON: Record<string, LucideIcon> = {
  closed: CircleCheck,
  reopened: CircleDot,
  merged: GitMerge,
  assigned: UserRound,
  unassigned: UserRound,
  labeled: Tag,
  unlabeled: Tag,
  renamed: Pencil,
  'cross-referenced': Link2,
  referenced: GitCommitHorizontal,
  committed: GitCommitHorizontal,
  added_to_project_v2: SquareKanban,
  removed_from_project_v2: SquareKanban,
  project_v2_item_status_changed: SquareKanban,
  parent_issue_added: ArrowRightLeft,
  parent_issue_removed: ArrowRightLeft,
  locked: CircleSlash
}

const day = (iso: string): string => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '')

function Avatar({ login }: { login: string | null }): React.JSX.Element {
  return login ? (
    <img src={`https://github.com/${login}.png?size=48`} alt="" className="size-6 shrink-0 rounded-full bg-muted" />
  ) : (
    <span className="size-6 shrink-0 rounded-full bg-muted" />
  )
}

/** A post on the thread — the opening one or a comment — as GitHub frames it: who, when, what. */
function Post({ author, at, verb, body, repoUrl }: { author: string | null; at: string; verb: string; body: string; repoUrl: string }): React.JSX.Element {
  const text = useMemo(() => linkIssueRefs(body.trim() || '_No description provided._', repoUrl), [body, repoUrl])
  return (
    <article className="relative overflow-hidden rounded-lg border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2 text-xs">
        <Avatar login={author} />
        <span className="font-semibold text-foreground">{author ?? 'ghost'}</span>
        <span className="text-muted-foreground">
          {verb} on {day(at)}
        </span>
      </header>
      <MessageMarkdown className="px-4 py-3 text-sm">{text}</MessageMarkdown>
    </article>
  )
}

function Event({ item, onOpenIssue }: { item: Extract<IssueTimelineItem, { type: 'event' }>; onOpenIssue: (number: number) => void }): React.JSX.Element {
  const Icon = EVENT_ICON[item.event]
  return (
    <div className="relative flex items-center gap-2 py-1.5 pl-1 text-xs text-muted-foreground">
      <span className="z-10 grid size-6 shrink-0 place-items-center rounded-full border border-border bg-background">
        {Icon ? <Icon aria-hidden="true" className="size-3.5" /> : <span className="size-1.5 rounded-full bg-muted-foreground" />}
      </span>
      <Avatar login={item.actor} />
      <span className="min-w-0">
        <span className="font-semibold text-foreground">{item.actor ?? 'Someone'}</span> {item.text}
        {item.ref !== null ? (
          <button type="button" onClick={() => onOpenIssue(item.ref!)} className="ml-1 text-primary underline-offset-2 hover:underline">
            open #{item.ref}
          </button>
        ) : null}{' '}
        <span className="whitespace-nowrap">on {day(item.createdAt)}</span>
      </span>
    </div>
  )
}

/**
 * Sends a click on a link inside the thread where it belongs: another issue or PR of this
 * repository opens in Canopy, an attached file opens in Canopy's reader, and anything else is
 * left to the app-wide handler that opens the browser.
 */
function useThreadLinks(repoUrl: string, { onOpenIssue, onOpenAttachment }: IssueLinkHandlers): (event: React.MouseEvent) => void {
  return (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey) return
    const anchor = (event.target as Element).closest('a[href]')
    if (!(anchor instanceof HTMLAnchorElement)) return
    const link = classifyGitHubLink(anchor.href, repoUrl)
    if (link.kind === 'external') return
    event.preventDefault()
    if (link.kind === 'issue') onOpenIssue(link.number)
    else onOpenAttachment(link.url)
  }
}

/** One issue or PR read as GitHub shows it: title, state, the opening post and everything since. */
export function IssueThreadView({ thread, ...handlers }: { thread: IssueThread } & IssueLinkHandlers): React.JSX.Element {
  const { openExternal } = usePlatform()
  const repoUrl = repoUrlOf(thread.url)
  const onClick = useThreadLinks(repoUrl, handlers)
  const comments = thread.timeline.filter((item) => item.type === 'comment').length
  return (
    <div onClick={onClick} className="mx-auto flex max-w-3xl flex-col gap-4 px-5 py-6">
      <header className="flex flex-col gap-3 border-b border-border pb-4">
        <div className="flex items-start gap-3">
          <h1 className="min-w-0 flex-1 text-xl leading-snug font-semibold">
            {thread.title} <span className="font-normal text-muted-foreground">#{thread.number}</span>
          </h1>
          <Button size="sm" variant="outline" className="h-7 shrink-0 text-xs" onClick={() => openExternal(thread.url)}>
            <ExternalLink aria-hidden="true" /> GitHub
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <IssueStateBadge state={thread.state} kind={thread.kind} />
          <span>
            <span className="font-semibold text-foreground">{thread.author ?? 'ghost'}</span> opened this on {day(thread.createdAt)} · {comments === 1 ? '1 comment' : `${comments} comments`}
          </span>
        </div>
      </header>
      <Post author={thread.author} at={thread.createdAt} verb="opened" body={thread.body} repoUrl={repoUrl} />
      <ol className="relative flex flex-col gap-2 before:absolute before:top-0 before:bottom-0 before:left-4 before:w-px before:bg-border">
        {thread.timeline.map((item) => (
          <li key={item.id} className="relative">
            {item.type === 'comment' ? (
              <Post author={item.author} at={item.createdAt} verb="commented" body={item.body} repoUrl={repoUrl} />
            ) : (
              <Event item={item} onOpenIssue={handlers.onOpenIssue} />
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}

/** An issue or PR of the project, read from GitHub through the daemon. */
export function IssueView({ projectId, number, ...handlers }: { projectId: string; number: number } & IssueLinkHandlers): React.JSX.Element {
  const issue = useIssue(projectId, number)
  if (issue.error) return <ErrorNote error={issue.error} />
  if (!issue.data) return <p className="p-4 text-xs text-muted-foreground">Reading #{number} from GitHub…</p>
  return <IssueThreadView thread={issue.data} {...handlers} />
}
