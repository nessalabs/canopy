import { useEffect, useState } from 'react'
import { CircleCheck, CircleX, GitMerge, MessageSquare, RotateCw } from 'lucide-react'

import type { MergeMethod, PullRequest, ReviewComment } from '@canopy/shared'

import { ErrorNote } from '@/components/error-note'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { SegmentedControl, SegmentedControlOption } from '@/components/ui/segmented-control'
import { Textarea } from '@/components/ui/textarea'
import { usePullRequestAction } from '@/lib/api-hooks'
import { plural } from '@/lib/format'
import { cn } from '@/lib/utils'

import { MERGE_STATE, TONE_CLASS } from './parts'

const METHOD_LABEL: Record<MergeMethod, string> = { merge: 'Merge commit', squash: 'Squash', rebase: 'Rebase' }
const METHOD_HINT: Record<MergeMethod, string> = {
  merge: 'Every commit lands, under a merge commit.',
  squash: 'One commit on the target, with the message below.',
  rebase: 'Each commit is replayed onto the target; no merge commit.'
}

/**
 * GitHub's merge box, as a dialog: method, message, delete the branch, or leave it to
 * auto-merge. Rebase is picked first when the repository allows it — this project keeps a
 * straight history.
 */
export function MergePullRequestDialog({
  worktreeId,
  pr,
  methods,
  open,
  onOpenChange,
  onDone
}: {
  worktreeId: string
  pr: PullRequest
  methods: MergeMethod[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: (message: string) => void
}): React.JSX.Element {
  const action = usePullRequestAction(worktreeId)
  const preferred: MergeMethod | undefined = methods.includes('rebase') ? 'rebase' : methods[0]
  const [method, setMethod] = useState<MergeMethod | undefined>(preferred)
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [deleteBranch, setDeleteBranch] = useState(true)
  const state = MERGE_STATE[pr.mergeState] ?? MERGE_STATE.UNKNOWN!
  // Auto-merge is for a PR waiting on something; a clean one merges now.
  const waiting = pr.mergeState !== 'CLEAN' && pr.mergeState !== 'HAS_HOOKS'
  const [auto, setAuto] = useState(false)

  useEffect(() => {
    if (!open) return
    action.reset()
    setMethod(preferred)
    setSubject('')
    setBody('')
    setAuto(false)
  }, [open])

  const defaultSubject = method === 'squash' ? `${pr.title} (#${pr.number})` : `Merge pull request #${pr.number} from ${pr.headBranch}`
  const submit = (): void => {
    if (!method) return
    action.mutate(
      { kind: 'merge', method, deleteBranch, auto, subject: method === 'rebase' ? undefined : subject.trim() || undefined, body: method === 'rebase' ? undefined : body || undefined },
      {
        onSuccess: (result) => {
          onOpenChange(false)
          onDone(result.message)
        }
      }
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitMerge className="size-4 text-muted-foreground" />
            Merge #{pr.number} into {pr.baseBranch}?
          </DialogTitle>
          <DialogDescription className={TONE_CLASS[state.tone]}>{state.hint}</DialogDescription>
        </DialogHeader>
        {methods.length === 0 ? (
          <p className="text-sm text-muted-foreground">This repository allows no merge method Canopy could read. Merge it on GitHub.</p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <SegmentedControl value={method} onValueChange={(value) => setMethod(value as MergeMethod)} aria-label="Merge method">
                {methods.map((option) => (
                  <SegmentedControlOption key={option} value={option}>
                    {METHOD_LABEL[option]}
                  </SegmentedControlOption>
                ))}
              </SegmentedControl>
              {method ? <p className="text-xs text-muted-foreground">{METHOD_HINT[method]}</p> : null}
            </div>
            {method && method !== 'rebase' ? (
              <>
                <Input className="font-mono text-xs" placeholder={defaultSubject} aria-label="Commit subject" value={subject} disabled={action.isPending} onChange={(event) => setSubject(event.target.value)} />
                <Textarea className="min-h-16 font-mono text-xs" placeholder="Commit message (optional)" aria-label="Commit message" value={body} disabled={action.isPending} onChange={(event) => setBody(event.target.value)} />
              </>
            ) : null}
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={deleteBranch} disabled={action.isPending || auto} onChange={(event) => setDeleteBranch(event.target.checked)} />
              Delete <span className="font-mono text-xs">{pr.headBranch}</span> on GitHub afterwards
            </label>
            {waiting ? (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={auto} disabled={action.isPending} onChange={(event) => setAuto(event.target.checked)} />
                Merge automatically once its requirements pass
              </label>
            ) : null}
            <p className="text-xs text-muted-foreground">The local branch and this worktree stay as they are.</p>
            <ErrorNote error={action.error} />
          </div>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="sm" disabled={action.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button size="sm" disabled={!method || action.isPending || (!state.mergeable && !auto)} onClick={submit}>
            {action.isPending ? <RotateCw className="animate-spin" /> : <GitMerge />}
            {action.isPending ? 'Merging…' : auto ? 'Enable auto-merge' : method ? `${METHOD_LABEL[method]} and merge` : 'Merge'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type ReviewEvent = 'comment' | 'approve' | 'request-changes'

/**
 * Local line comments that can ride along as inline comments: unsent, and left on the PR's
 * whole diff or on its head commit — a comment on an older commit points at lines that may no
 * longer be where GitHub's diff has them.
 */
export const postableComments = (comments: ReviewComment[], pr: PullRequest): ReviewComment[] =>
  comments.filter((comment) => !comment.sent && (!comment.commitSha || comment.commitSha === pr.headSha))

/** Submit a review the way GitHub's "Review changes" does, with local comments posted inline. */
export function ReviewDialog({
  worktreeId,
  pr,
  viewer,
  comments,
  open,
  onOpenChange,
  onDone
}: {
  worktreeId: string
  pr: PullRequest
  viewer: string | null
  comments: ReviewComment[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: (message: string) => void
}): React.JSX.Element {
  const action = usePullRequestAction(worktreeId)
  const own = viewer !== null && viewer === pr.author
  const postable = postableComments(comments, pr)
  const [event, setEvent] = useState<ReviewEvent>('comment')
  const [body, setBody] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!open) return
    action.reset()
    setEvent('comment')
    setBody('')
    setPicked(new Set(postable.map((comment) => comment.id)))
  }, [open])

  const empty = event !== 'approve' && body.trim() === '' && picked.size === 0
  const submit = (): void => {
    action.mutate(
      { kind: 'review', event, body, commentIds: [...picked] },
      {
        onSuccess: (result) => {
          onOpenChange(false)
          onDone(result.message)
        }
      }
    )
  }
  const toggle = (id: string, on: boolean): void =>
    setPicked((current) => {
      const next = new Set(current)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Review #{pr.number}</DialogTitle>
          <DialogDescription>{own ? 'This is your own pull request, so GitHub only takes comments on it.' : 'Posted to GitHub as you, through gh.'}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <SegmentedControl value={event} onValueChange={(value) => setEvent(value as ReviewEvent)} aria-label="Review verdict">
            <SegmentedControlOption value="comment">
              <MessageSquare className="size-3.5" /> Comment
            </SegmentedControlOption>
            <SegmentedControlOption value="approve" disabled={own}>
              <CircleCheck className="size-3.5" /> Approve
            </SegmentedControlOption>
            <SegmentedControlOption value="request-changes" disabled={own}>
              <CircleX className="size-3.5" /> Request changes
            </SegmentedControlOption>
          </SegmentedControl>
          <Textarea className="min-h-28 text-sm" placeholder="Leave a comment (Markdown)" aria-label="Review comment" value={body} disabled={action.isPending} onChange={(e) => setBody(e.target.value)} />
          {postable.length ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">Post these line comments with it, inline on the PR’s diff</span>
              <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-lg border border-border p-2">
                {postable.map((comment) => (
                  <li key={comment.id}>
                    <label className="flex items-start gap-2 text-xs">
                      <Checkbox className="mt-0.5" checked={picked.has(comment.id)} disabled={action.isPending} onChange={(e) => toggle(comment.id, e.target.checked)} />
                      <span className="min-w-0 flex-1">
                        <span className="font-mono text-muted-foreground">
                          {comment.file}:{comment.line}
                        </span>{' '}
                        <span className="line-clamp-2">{comment.text}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <ErrorNote error={action.error} />
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="sm" disabled={action.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button size="sm" disabled={action.isPending || empty} onClick={submit} className={cn(event === 'request-changes' && 'bg-destructive text-destructive-foreground hover:bg-destructive/90')}>
            {action.isPending ? <RotateCw className="animate-spin" /> : null}
            {action.isPending ? 'Submitting…' : `Submit review${picked.size ? ` · ${plural(picked.size, 'comment')}` : ''}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
