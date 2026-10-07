import { useMemo, useState } from 'react'
import { Bot, CheckCircle2, CornerDownRight, ExternalLink } from 'lucide-react'

import type { GitHubNote, GitHubThread, ReviewComment } from '@canopy/shared'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { FileDiffPath } from '@/components/ui/file-diff-list'
import { SegmentedControl, SegmentedControlOption } from '@/components/ui/segmented-control'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { absoluteTime, plural, relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'

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

type Filter = 'open' | 'all'

/**
 * The PR's review threads from GitHub, under the local comments in the Comments pane: read
 * them here, jump to the line, or tick some and hand them to an agent with the same picker
 * local comments use.
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
  const open = useExternalLink()
  const [filter, setFilter] = useState<Filter>('open')
  const unresolved = threads.filter((thread) => !thread.resolved)
  const shown = filter === 'open' ? unresolved : threads
  const groups = useMemo(() => {
    const byFile = new Map<string, GitHubThread[]>()
    for (const thread of shown) byFile.set(thread.file, [...(byFile.get(thread.file) ?? []), thread])
    return [...byFile].sort((a, b) => a[0].localeCompare(b[0]))
  }, [shown])
  const pickedShown = shown.filter((thread) => picked.has(thread.id)).length

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          From GitHub · PR #{number} · {plural(threads.length, 'thread')}
          {unresolved.length ? `, ${unresolved.length} open` : ''}
        </h3>
        <SegmentedControl value={filter} onValueChange={(value) => setFilter(value as Filter)} aria-label="Which threads" className="h-7">
          <SegmentedControlOption value="open">Open</SegmentedControlOption>
          <SegmentedControlOption value="all">All</SegmentedControlOption>
        </SegmentedControl>
        <div className="ml-auto flex items-center gap-2">
          {shown.length ? (
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => shown.forEach((thread) => onPick(thread.id, pickedShown < shown.length))}>
              {pickedShown < shown.length ? 'Select all' : 'Select none'}
            </Button>
          ) : null}
          <Button size="sm" className="h-7" disabled={picked.size === 0 || sending} onClick={onSend}>
            <Bot />
            Send {picked.size ? plural(picked.size, 'thread') : 'to agent'}
          </Button>
        </div>
      </div>
      {threads.length === 0 ? (
        <p className="rounded-lg border border-border px-4 py-6 text-center text-sm text-muted-foreground">No review comments on GitHub yet.</p>
      ) : shown.length === 0 ? (
        <p className="rounded-lg border border-border px-4 py-6 text-center text-sm text-muted-foreground">Every thread is resolved.</p>
      ) : (
        groups.map(([file, list]) => (
          <div key={file} className="overflow-hidden rounded-lg border border-border">
            <h4 className="flex items-center gap-2 bg-muted/30 px-3 py-2 font-mono text-xs">
              <FileDiffPath path={file} className="min-w-0 flex-1" />
              <span className="text-[10px] text-muted-foreground">{plural(list.length, 'thread')}</span>
            </h4>
            <ul className="flex flex-col divide-y divide-border/60">
              {list.map((thread) => (
                <li key={thread.id} className={cn('flex gap-3 px-3 py-2', thread.resolved && 'opacity-70')}>
                  <Checkbox className="mt-1" checked={picked.has(thread.id)} onChange={(event) => onPick(thread.id, event.target.checked)} aria-label="Include in the review request" />
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                      <button type="button" className="font-mono hover:text-foreground disabled:cursor-default" disabled={thread.line === null} onClick={() => onJump(thread)}>
                        line {thread.line ?? thread.originalLine ?? '?'}
                        {thread.side === 'old' ? ' (removed)' : ''}
                      </button>
                      {thread.resolved ? (
                        <Badge variant="secondary" className="px-1 text-[9px]">
                          <CheckCircle2 /> resolved
                        </Badge>
                      ) : null}
                      {thread.outdated ? (
                        <Badge variant="outline" className="px-1 text-[9px]">
                          outdated
                        </Badge>
                      ) : null}
                      {thread.line !== null ? (
                        <Button variant="ghost" size="icon" className="size-5 text-muted-foreground" aria-label="Jump to the line" onClick={() => onJump(thread)}>
                          <CornerDownRight className="size-3" />
                        </Button>
                      ) : null}
                      {thread.comments[0]?.url ? (
                        <a href={thread.comments[0].url} target="_blank" rel="noreferrer" onClick={open(thread.comments[0].url)} className="ml-auto flex items-center gap-1 hover:text-foreground">
                          GitHub <ExternalLink className="size-3" />
                        </a>
                      ) : null}
                    </div>
                    {thread.comments.map((comment) => (
                      <article key={comment.id} className="flex gap-2">
                        <GitHubAvatar login={comment.author} host={host} className="mt-0.5 size-5 shrink-0 rounded-full" />
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center gap-1.5 text-xs">
                            <span className="font-medium">{comment.author}</span>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="font-mono text-[10px] text-muted-foreground">{relativeTime(at(comment.at))}</span>
                              </TooltipTrigger>
                              <TooltipContent>{absoluteTime(at(comment.at))}</TooltipContent>
                            </Tooltip>
                          </p>
                          <Markdown>{comment.body}</Markdown>
                        </div>
                      </article>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  )
}
