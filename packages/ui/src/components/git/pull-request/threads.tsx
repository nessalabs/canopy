import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, Bot, CheckCircle2, ExternalLink, GitPullRequest, MessagesSquare } from 'lucide-react'

import type { GitHubNote, GitHubThread, PullRequestEvent, ReviewComment } from '@canopy/shared'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { SegmentedControl, SegmentedControlOption } from '@/components/ui/segmented-control'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { absoluteTime, plural, relativeTime } from '@/lib/format'
import { groupBy } from '@/lib/group'
import { cn } from '@/lib/utils'

import { HOVER_ACTIONS } from '../comment-card'
import { EmptySection, FileGroup, PaneSection } from '../pane-section'
import { SendToAgentButton } from '../send-to-agent'
import { GitHubAvatar, Markdown, at, useExternalLink } from './parts'

/**
 * A thread as the diff viewer shows comments: one card per reply on the thread's line, marked
 * as GitHub's so the card names the reviewer, links out and offers no delete. Counted as sent,
 * so it is never posted back to GitHub or picked up by "send unsent comments". Outdated threads
 * have no line in the current diff and stay in the Comments pane only.
 */
export function threadsAsComments(threads: GitHubThread[], worktreeId: string, host: string | null): ReviewComment[] {
  const out: ReviewComment[] = []
  for (const thread of threads) {
    if (thread.line === null) continue
    for (const comment of thread.comments) {
      out.push({
        id: `gh:${comment.id}`,
        worktreeId,
        file: thread.file,
        line: thread.line,
        side: thread.side,
        text: comment.body,
        createdAt: at(comment.at),
        sent: true,
        github: { author: comment.author, url: comment.url, resolved: thread.resolved, host }
      })
    }
  }
  return out
}

/** What the agent gets for a thread: every reply, oldest first, each with its author. */
export function threadAsNote(thread: GitHubThread): GitHubNote {
  const first = thread.comments[0]
  return {
    author: first?.author ?? 'ghost',
    file: thread.file,
    line: thread.line ?? thread.originalLine ?? undefined,
    side: thread.side,
    body: thread.comments.map((comment) => `${comment.author}: ${comment.body.trim()}`).join('\n'),
    url: first?.url ?? '',
    resolved: thread.resolved
  }
}

/** One reply from a thread, for sending on its own; `comment.github` must be set. */
export function replyAsNote(comment: ReviewComment): GitHubNote {
  const author = comment.github?.author ?? 'ghost'
  return { author, file: comment.file, line: comment.line, side: comment.side, body: `${author}: ${comment.text.trim()}`, url: comment.github?.url ?? '', resolved: comment.github?.resolved ?? false }
}

/** A comment or review on the PR's conversation: no file, so it links to the PR itself. */
export function eventAsNote(event: PullRequestEvent, prUrl: string): GitHubNote {
  return { author: event.author, body: `${event.author}: ${event.body.trim()}`, url: prUrl, resolved: false }
}

type Filter = 'open' | 'all'

/**
 * The PR's review threads from GitHub, under the local comments in the Comments pane: read
 * them here, jump to the line, send one to an agent on its own, or tick several and send them
 * with the same picker local comments use.
 */
export function GitHubThreadsPanel({
  number,
  threads,
  host,
  picked,
  onPick,
  onJump,
  onSend,
  sending
}: {
  number: number
  threads: GitHubThread[]
  host: string | null
  picked: Set<string>
  onPick: (id: string, on: boolean) => void
  onJump: (thread: GitHubThread) => void
  onSend: () => void
  sending: boolean
}): React.JSX.Element {
  const [filter, setFilter] = useState<Filter>('open')
  const unresolved = threads.filter((thread) => !thread.resolved)
  const shown = filter === 'open' ? unresolved : threads
  const groups = useMemo(() => [...groupBy(shown, (thread) => thread.file)].sort((a, b) => a[0].localeCompare(b[0])), [shown])
  const pickedShown = shown.filter((thread) => picked.has(thread.id)).length

  const actions = (
    <>
      <SegmentedControl value={filter} onValueChange={(value) => setFilter(value as Filter)} aria-label="Which threads" className="h-7 text-xs">
        <SegmentedControlOption value="open">Open · {unresolved.length}</SegmentedControlOption>
        <SegmentedControlOption value="all">All · {threads.length}</SegmentedControlOption>
      </SegmentedControl>
      {shown.length ? (
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => shown.forEach((thread) => onPick(thread.id, pickedShown < shown.length))}>
          {pickedShown < shown.length ? 'Select all' : 'Clear'}
        </Button>
      ) : null}
      {threads.length ? (
        <Button size="sm" className="h-7 text-xs" disabled={picked.size === 0 || sending} onClick={onSend}>
          <Bot />
          {picked.size ? `Send ${plural(picked.size, 'thread')}` : 'Send selected'}
        </Button>
      ) : null}
    </>
  )

  return (
    <PaneSection icon={GitPullRequest} title={`From GitHub · #${number}`} count={threads.length} summary={threads.length ? `${unresolved.length} open` : undefined} actions={actions}>
      {threads.length === 0 ? (
        <EmptySection icon={MessagesSquare} title="No review comments on GitHub" hint="When someone reviews the pull request, their line comments show up here, ready to hand to an agent." />
      ) : shown.length === 0 ? (
        <EmptySection icon={CheckCircle2} title="Every thread is resolved" hint="Switch to All to read the resolved ones." />
      ) : (
        groups.map(([file, list]) => (
          <FileGroup key={file} file={file} count={list.length} noun="thread">
            {list.map((thread) => (
              <ThreadRow key={thread.id} thread={thread} host={host} picked={picked.has(thread.id)} onPick={(on) => onPick(thread.id, on)} onJump={() => onJump(thread)} />
            ))}
          </FileGroup>
        ))
      )}
    </PaneSection>
  )
}

/**
 * One thread: a tick to include it in a batch, where it sits, its replies, and its own send.
 * Without `onPick` there is no tick, and without `onJump` the place is a label, not a link; the
 * conversation shows threads under their review that way, naming the file as well.
 */
export function ThreadRow({
  thread,
  host,
  picked = false,
  onPick,
  onJump,
  showFile = false
}: {
  thread: GitHubThread
  host: string | null
  picked?: boolean
  onPick?: (on: boolean) => void
  onJump?: () => void
  showFile?: boolean
}): React.JSX.Element {
  const open = useExternalLink()
  const url = thread.comments[0]?.url
  const line = thread.line ?? thread.originalLine
  return (
    <li className={cn('group/card flex gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted/40', picked && 'bg-primary/5', thread.resolved && 'opacity-75')}>
      {onPick ? <Checkbox className="mt-1.5" checked={picked} onChange={(event) => onPick(event.target.checked)} aria-label="Include in the batch sent to an agent" /> : null}
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex min-h-7 flex-wrap items-center gap-2 text-xs">
          <button
            type="button"
            className="flex items-center gap-1 rounded-md border border-border/70 bg-background/60 px-1.5 py-0.5 font-mono text-[11px] text-foreground/80 transition-colors hover:border-primary/50 hover:text-foreground disabled:pointer-events-none disabled:text-muted-foreground"
            disabled={thread.line === null || !onJump}
            title={thread.line === null ? 'This line is no longer in the diff' : onJump ? 'Show in the diff' : undefined}
            onClick={onJump}
          >
            {showFile ? `${thread.file}:${line ?? '?'}` : `Line ${line ?? '?'}`}
            {thread.side === 'old' ? ' (removed)' : ''}
            {thread.line !== null && onJump ? <ArrowUpRight className="size-3 text-muted-foreground" /> : null}
          </button>
          {thread.resolved ? (
            <Badge variant="secondary">
              <CheckCircle2 /> Resolved
            </Badge>
          ) : null}
          {thread.outdated ? <Badge variant="outline">Outdated</Badge> : null}
          <div className={cn('ml-auto', HOVER_ACTIONS)}>
            <SendToAgentButton note={() => threadAsNote(thread)} />
            {url ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label="Open on GitHub" asChild>
                    <a href={url} target="_blank" rel="noreferrer" onClick={open(url)}>
                      <ExternalLink className="size-3.5" />
                    </a>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Open on GitHub</TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        </div>
        {thread.hunk ? <HunkTail hunk={thread.hunk} /> : null}
        {thread.comments.map((comment) => (
          <article key={comment.id} className="flex gap-2.5">
            <GitHubAvatar login={comment.author} host={host} className="mt-0.5 size-6 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-xs">
                <span className="text-sm font-medium">{comment.author}</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <time className="text-muted-foreground">{relativeTime(at(comment.at))}</time>
                  </TooltipTrigger>
                  <TooltipContent>{absoluteTime(at(comment.at))}</TooltipContent>
                </Tooltip>
              </p>
              <ClampedBody>{comment.body}</ClampedBody>
            </div>
          </article>
        ))}
      </div>
    </li>
  )
}

/** How many lines of code above a comment show with it, as GitHub's conversation does. */
const HUNK_LINES = 4

/** The last few lines of the thread's diff hunk: the commented line and what leads up to it. */
export function HunkTail({ hunk }: { hunk: string }): React.JSX.Element {
  const lines = hunk.split('\n').filter((line) => !line.startsWith('@@') && !line.startsWith('\\')).slice(-HUNK_LINES)
  return (
    <pre className="overflow-x-auto rounded-md border border-border/70 bg-muted/30 py-1 font-mono text-[11px] leading-5">
      {lines.map((line, index) => (
        <div
          key={index}
          className={cn('px-2 whitespace-pre', line.startsWith('+') && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300', line.startsWith('-') && 'bg-red-500/10 text-red-700 dark:text-red-300')}
        >
          {line || ' '}
        </div>
      ))}
    </pre>
  )
}

/** Review bots write screens of text; a reply shows its first few lines until asked for the rest. */
export function ClampedBody({ children }: { children: string }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  useLayoutEffect(() => {
    const node = ref.current
    if (node) setOverflows(node.scrollHeight > node.clientHeight + 1)
  }, [children])
  return (
    <div className="flex flex-col items-start gap-1">
      <div ref={ref} className={cn('relative w-full text-sm', !expanded && 'max-h-40 overflow-hidden', !expanded && overflows && 'mask-b-from-60%')}>
        <Markdown>{children}</Markdown>
      </div>
      {overflows || expanded ? (
        <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show less' : 'Show more'}
        </Button>
      ) : null}
    </div>
  )
}
