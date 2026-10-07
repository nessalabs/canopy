import { CornerDownRight, ExternalLink, X } from 'lucide-react'

import type { ReviewComment } from '@canopy/shared'

import { Badge } from '@/components/ui/badge'
import { GitHubAvatar } from '@/components/git/pull-request/parts'
import { usePlatform } from '@/providers/platform'
import { Button } from '@/components/ui/button'
import { FileDiffPath } from '@/components/ui/file-diff-list'
import { relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * One review comment, wherever it is shown: inline under its diff line (no anchor needed)
 * or in the Comments panel (anchor + jump). Delete is offered only while unsent. A comment
 * that came from a GitHub review thread names its author, links out, and cannot be deleted.
 */
export function CommentCard({
  comment,
  showAnchor = false,
  onJump,
  onDelete,
  className
}: {
  comment: ReviewComment
  showAnchor?: boolean
  onJump?: (comment: ReviewComment) => void
  onDelete?: (comment: ReviewComment) => void
  className?: string
}): React.JSX.Element {
  const { openExternal } = usePlatform()
  const github = comment.github
  return (
    <div className={cn('flex items-start gap-2 text-xs', className)}>
      {github ? (
        <GitHubAvatar login={github.author} host={github.host} className="mt-0.5 size-4 shrink-0 rounded-full" />
      ) : (
        <span className="mt-0.5 size-4 shrink-0 rounded-full bg-primary/20 text-center font-mono text-[9px] leading-4">Y</span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="font-medium">{github ? github.author : 'you'}</span>
          {showAnchor ? (
            <button type="button" className="flex min-w-0 items-center gap-1 font-mono text-[10px] text-muted-foreground hover:text-foreground" onClick={() => onJump?.(comment)}>
              <FileDiffPath path={comment.file} className="truncate" />:{comment.line}
              {comment.side === 'old' ? ' (removed)' : ''}
              {comment.commitSha ? ` @ ${comment.commitSha.slice(0, 7)}` : ''}
            </button>
          ) : null}
          <span className="font-mono text-[10px] text-muted-foreground">{relativeTime(comment.createdAt)}</span>
          {github ? (
            <a
              href={github.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground hover:text-foreground"
              onClick={(event) => {
                event.preventDefault()
                openExternal(github.url)
              }}
            >
              GitHub{github.resolved ? ' · resolved' : ''} <ExternalLink className="size-2.5" />
            </a>
          ) : (
            <Badge variant={comment.sent ? 'secondary' : 'outline'} className="px-1 text-[9px]">
              {comment.sent ? 'sent' : 'unsent'}
            </Badge>
          )}
        </div>
        {comment.code ? <pre className="mt-1 truncate rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{comment.code.trim()}</pre> : null}
        <p className="mt-0.5 whitespace-pre-wrap text-foreground">{comment.text}</p>
      </div>
      {onJump && showAnchor ? (
        <Button variant="ghost" size="icon" className="size-5 shrink-0 text-muted-foreground" aria-label="Jump to comment" onClick={() => onJump(comment)}>
          <CornerDownRight className="size-3" />
        </Button>
      ) : null}
      {onDelete && !comment.sent ? (
        <Button variant="ghost" size="icon" className="size-5 shrink-0 text-muted-foreground" aria-label="Delete comment" onClick={() => onDelete(comment)}>
          <X className="size-3" />
        </Button>
      ) : null}
    </div>
  )
}
