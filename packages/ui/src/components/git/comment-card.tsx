import { ArrowUpRight, Check, ExternalLink, Trash2 } from 'lucide-react'

import type { ReviewComment } from '@canopy/shared'

import { GitHubAvatar } from '@/components/git/pull-request/parts'
import { replyAsNote } from '@/components/git/pull-request/threads'
import { SendToAgentButton } from '@/components/git/send-to-agent'
import { Button } from '@/components/ui/button'
import { FileDiffPath } from '@/components/ui/file-diff-list'
import { StatusDot } from '@/components/ui/status-dot'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { absoluteTime, relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { usePlatform } from '@/providers/platform'

/**
 * How much of the comment's location to show: nothing under its own diff line, the line alone
 * inside a group already headed by the file, or file and line where nothing else says which file.
 */
export type CommentAnchor = 'none' | 'line' | 'full'

/**
 * Actions sit quietly until the card is hovered or focused, so a list of comments reads as text
 * first. Devices without hover (touch) always show them.
 */
export const HOVER_ACTIONS = 'flex shrink-0 items-center gap-0.5 transition-opacity [@media(hover:hover)]:opacity-0 group-hover/card:opacity-100 group-focus-within/card:opacity-100'

/**
 * One review comment, wherever it is shown: under its diff line, in the Comments pane, or in the
 * rail's preview. Delete is offered only while unsent. A comment from a GitHub review thread names
 * its reviewer, links out, can be handed to an agent on its own, and cannot be deleted.
 */
export function CommentCard({
  comment,
  anchor = 'none',
  onJump,
  onDelete,
  className
}: {
  comment: ReviewComment
  anchor?: CommentAnchor
  onJump?: (comment: ReviewComment) => void
  onDelete?: (comment: ReviewComment) => void
  className?: string
}): React.JSX.Element {
  const github = comment.github
  return (
    <article className={cn('group/card flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted/40', className)}>
      {github ? (
        <GitHubAvatar login={github.author} host={github.host} className="mt-0.5 size-6 shrink-0 rounded-full" />
      ) : (
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">You</span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <header className="flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <span className="text-sm font-medium">{github ? github.author : 'You'}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <time className="text-muted-foreground">{relativeTime(comment.createdAt)}</time>
            </TooltipTrigger>
            <TooltipContent>{absoluteTime(comment.createdAt)}</TooltipContent>
          </Tooltip>
          {github ? <GitHubLink url={github.url} resolved={github.resolved} /> : <SentState sent={comment.sent} />}
          <div className={cn('ml-auto', HOVER_ACTIONS)}>
            {github ? <SendToAgentButton note={() => replyAsNote(comment)} /> : null}
            {onDelete && !comment.sent ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-destructive" aria-label="Delete comment" onClick={() => onDelete(comment)}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Delete</TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        </header>
        {anchor !== 'none' ? <Location comment={comment} full={anchor === 'full'} onJump={onJump} /> : null}
        {comment.code ? (
          <blockquote className="flex gap-2 overflow-hidden rounded-md border-l-2 border-primary/50 bg-muted/50 px-2.5 py-1 font-mono text-[11px] text-muted-foreground">
            <span className="shrink-0 tabular-nums opacity-60">{comment.line}</span>
            <span className="truncate">{comment.code.trim()}</span>
          </blockquote>
        ) : null}
        <p className="text-sm leading-relaxed whitespace-pre-wrap text-foreground">{comment.text}</p>
      </div>
    </article>
  )
}

/** Where the comment sits, as a chip that takes you there when the host can jump. */
function Location({ comment, full, onJump }: { comment: ReviewComment; full: boolean; onJump?: (comment: ReviewComment) => void }): React.JSX.Element {
  const label = (
    <>
      {full ? <FileDiffPath path={comment.file} className="min-w-0 truncate" /> : null}
      <span className="shrink-0">
        {full ? ':' : 'Line '}
        {comment.line}
        {comment.side === 'old' ? ' (removed)' : ''}
      </span>
      {comment.commitSha ? <span className="shrink-0 text-muted-foreground">in {comment.commitSha.slice(0, 7)}</span> : null}
    </>
  )
  const chip = 'flex w-fit max-w-full items-center gap-1 rounded-md border border-border/70 bg-background/60 px-1.5 py-0.5 font-mono text-[11px]'
  if (!onJump) return <span className={cn(chip, 'text-muted-foreground')}>{label}</span>
  return (
    <button type="button" className={cn(chip, 'text-foreground/80 transition-colors hover:border-primary/50 hover:text-foreground')} onClick={() => onJump(comment)} title="Show in the diff">
      {label}
      <ArrowUpRight className="size-3 shrink-0 text-muted-foreground" />
    </button>
  )
}

function SentState({ sent }: { sent: boolean }): React.JSX.Element {
  return sent ? (
    <span className="flex items-center gap-1 text-muted-foreground">
      <Check className="size-3" /> Sent
    </span>
  ) : (
    <span className="flex items-center gap-1.5 font-medium text-amber-600 dark:text-amber-500">
      <StatusDot className="bg-current" /> Not sent
    </span>
  )
}

function GitHubLink({ url, resolved }: { url: string; resolved: boolean }): React.JSX.Element {
  const { openExternal } = usePlatform()
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
      onClick={(event) => {
        event.preventDefault()
        openExternal(url)
      }}
    >
      {resolved ? <Check className="size-3" /> : null}
      {resolved ? 'Resolved on GitHub' : 'GitHub'}
      <ExternalLink className="size-3" />
    </a>
  )
}
