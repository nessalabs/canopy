import { useMemo } from 'react'

import type { ReviewComment } from '@canopy/shared'

import { ConversationRail, ConversationRailItem, ConversationRailMarker, ConversationRailPreview, ConversationRailTrigger } from '@/components/ui/conversation-rail'
import { FileDiffPath } from '@/components/ui/file-diff-list'
import { useDeleteComment } from '@/lib/api-hooks'
import { plural } from '@/lib/format'
import { groupBy } from '@/lib/group'

import { CommentCard } from './comment-card'

/**
 * Every comment on the worktree, grouped by file with unsent files first, plus a
 * conversation rail along the edge: one marker per comment, hover for the text, click to
 * jump to its line in the diff.
 */
export function CommentsPanel({ worktreeId, comments, onJump, className }: { worktreeId: string; comments: ReviewComment[]; onJump: (comment: ReviewComment) => void; className?: string }): React.JSX.Element {
  const remove = useDeleteComment(worktreeId)
  const groups = useMemo(() => {
    const byFile = [...groupBy(comments, (c) => c.file)]
    const unsent = (list: ReviewComment[]): number => list.filter((c) => !c.sent).length
    return byFile.sort((a, b) => unsent(b[1]) - unsent(a[1]) || a[0].localeCompare(b[0]))
  }, [comments])
  const unsentTotal = comments.filter((c) => !c.sent).length

  if (comments.length === 0) {
    return <div className="rounded-xl border border-border py-10 text-center text-sm text-muted-foreground">No comments yet — click a line's gutter in the diff to leave one.</div>
  }

  return (
    <div className={`flex gap-3 ${className ?? ''}`}>
      <ConversationRail aria-label="Comments" className="sticky top-0 shrink-0 self-start">
        {comments.map((comment) => (
          <ConversationRailItem key={comment.id} active={!comment.sent}>
            <ConversationRailTrigger aria-label={`${comment.file}:${comment.line}`} onClick={() => onJump(comment)}>
              <ConversationRailMarker />
            </ConversationRailTrigger>
            <ConversationRailPreview>
              <CommentCard comment={comment} showAnchor />
            </ConversationRailPreview>
          </ConversationRailItem>
        ))}
      </ConversationRail>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <p className="font-mono text-[11px] text-muted-foreground">
          {plural(comments.length, 'comment')} · {unsentTotal} unsent
        </p>
        {groups.map(([file, list]) => (
          <section key={file} className="overflow-hidden rounded-lg border border-border">
            <h3 className="flex items-center gap-2 bg-muted/30 px-3 py-2 font-mono text-xs">
              <FileDiffPath path={file} className="min-w-0 flex-1" />
              <span className="text-[10px] text-muted-foreground">{plural(list.length, 'comment')}</span>
            </h3>
            <ul className="flex flex-col divide-y divide-border/60">
              {list.map((comment) => (
                <li key={comment.id} className="px-3 py-2">
                  <CommentCard comment={comment} showAnchor onJump={onJump} onDelete={(c) => remove.mutate(c.id)} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}
