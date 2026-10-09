import { useMemo } from 'react'
import { MessageSquare, MessageSquareDashed } from 'lucide-react'

import type { ReviewComment } from '@canopy/shared'

import { ConversationRail, ConversationRailItem, ConversationRailMarker, ConversationRailPreview, ConversationRailTrigger } from '@/components/ui/conversation-rail'
import { useDeleteComment } from '@/lib/api-hooks'
import { groupBy } from '@/lib/group'

import { CommentCard } from './comment-card'
import { EmptySection, FileGroup, PaneSection } from './pane-section'

/** Below this many comments the list fits on screen and the rail would only be a stray mark. */
const RAIL_MIN = 4

/**
 * Every comment left on the worktree, grouped by file with unsent files first. A long list also
 * gets a conversation rail along its edge: one marker per comment, hover for the text, click to
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

  return (
    <PaneSection icon={MessageSquare} title="Your comments" count={comments.length} summary={comments.length ? (unsentTotal ? `${unsentTotal} not sent yet` : 'All sent') : undefined}>
      {comments.length === 0 ? (
        <EmptySection icon={MessageSquareDashed} title="No comments yet" hint="Click a line number in any diff to leave a note. Send them to an agent from here when you are done." />
      ) : (
        <div className={`flex gap-3 ${className ?? ''}`}>
          {comments.length >= RAIL_MIN ? (
            <ConversationRail aria-label="Comments" className="sticky top-0 shrink-0 self-start">
              {comments.map((comment) => (
                <ConversationRailItem key={comment.id} active={!comment.sent}>
                  <ConversationRailTrigger aria-label={`${comment.file}:${comment.line}`} onClick={() => onJump(comment)}>
                    <ConversationRailMarker />
                  </ConversationRailTrigger>
                  <ConversationRailPreview>
                    <CommentCard comment={comment} anchor="full" />
                  </ConversationRailPreview>
                </ConversationRailItem>
              ))}
            </ConversationRail>
          ) : null}
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            {groups.map(([file, list]) => (
              <FileGroup key={file} file={file} count={list.length} noun="comment">
                {list.map((comment) => (
                  <li key={comment.id}>
                    <CommentCard comment={comment} anchor="line" onJump={onJump} onDelete={(c) => remove.mutate(c.id)} />
                  </li>
                ))}
              </FileGroup>
            ))}
          </div>
        </div>
      )}
    </PaneSection>
  )
}
