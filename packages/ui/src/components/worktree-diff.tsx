import { useEffect, useMemo, useRef, useState } from 'react'

import type { CommentSide, DiffSpec, ReviewComment } from '@canopy/shared'

import { CommentCard } from '@/components/git/comment-card'
import { Button } from '@/components/ui/button'
import { DiffView, type DiffLineAnnotation, type SelectedLineRange } from '@/components/ui/diff-view'
import { Textarea } from '@/components/ui/textarea'
import { useAddComment, useDeleteComment } from '@/lib/api-hooks'
import { lineAt } from '@/lib/patch'
import { useTheme } from '@/lib/use-theme'

export type DiffMode = 'split' | 'unified'

interface CommentTarget {
  line: number
  side: CommentSide
}

type AnnotationPayload =
  | { kind: 'thread'; comments: ReviewComment[]; composing: boolean; target: CommentTarget }
  | { kind: 'composer'; target: CommentTarget }

const SIDE_TO_PIERRE = { old: 'deletions', new: 'additions' } as const

function CommentThread({ worktreeId, comments }: { worktreeId: string; comments: ReviewComment[] }): React.JSX.Element {
  const remove = useDeleteComment(worktreeId)
  return (
    <div className="flex flex-col gap-1.5 border-y border-border/60 bg-surface-panel px-4 py-2 font-sans">
      {comments.map((comment) => (
        <div key={comment.id} data-comment-id={comment.id}>
          <CommentCard comment={comment} onDelete={(c) => remove.mutate(c.id)} />
        </div>
      ))}
    </div>
  )
}

function CommentComposer({ target, onSubmit, onDone }: { target: CommentTarget; onSubmit: (text: string) => void; onDone: () => void }): React.JSX.Element {
  const [text, setText] = useState('')
  return (
    <div className="flex flex-col gap-2 border-y border-border/60 bg-surface-panel px-4 py-2 font-sans">
      <Textarea
        autoFocus
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={`Comment on line ${target.line}…`}
        className="min-h-14 text-xs"
        aria-label={`Comment on line ${target.line}`}
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onDone}>
          Cancel
        </Button>
        <Button
          size="sm"
          className="h-7 text-xs"
          disabled={text.trim() === ''}
          onClick={() => {
            onSubmit(text.trim())
            onDone()
          }}
        >
          Add comment
        </Button>
      </div>
    </div>
  )
}

/**
 * One file's diff with the worktree's line comments anchored through nessa DiffView's
 * annotation slots. Click a line's gutter "+" to comment. Works for working-tree and
 * commit diffs alike; a commit spec stamps `commitSha` onto new comments.
 */
export function WorktreeDiff({
  worktreeId,
  spec,
  path,
  patch,
  comments,
  mode,
  headerExtra,
  focusCommentId
}: {
  worktreeId: string
  spec: DiffSpec
  path: string
  patch: string
  comments: ReviewComment[]
  mode: DiffMode
  headerExtra?: React.ReactNode
  /** Scrolls this comment into view once the diff has rendered (the Comments panel's "jump"). */
  focusCommentId?: string
}): React.JSX.Element {
  const { theme } = useTheme()
  const add = useAddComment(worktreeId)
  const [composer, setComposer] = useState<CommentTarget>()
  const container = useRef<HTMLDivElement>(null)

  // nessa DiffView has no scroll-to-line API; the rendered annotation carries the id instead.
  useEffect(() => {
    if (!focusCommentId) return
    container.current?.querySelector(`[data-comment-id="${focusCommentId}"]`)?.scrollIntoView({ block: 'center' })
  }, [focusCommentId, patch])

  const submit = (target: CommentTarget, text: string): void => {
    add.mutate({
      file: path,
      line: target.line,
      side: target.side,
      text,
      code: lineAt(patch, target.side, target.line),
      commitSha: spec.kind === 'commit' ? spec.sha : undefined
    })
  }

  const lineAnnotations = useMemo(() => {
    const grouped = new Map<string, ReviewComment[]>()
    for (const comment of comments) grouped.set(`${comment.side}:${comment.line}`, [...(grouped.get(`${comment.side}:${comment.line}`) ?? []), comment])
    const annotations: DiffLineAnnotation<AnnotationPayload>[] = [...grouped].map(([key, thread]) => {
      const [side, line] = key.split(':') as [CommentSide, string]
      const target = { line: Number(line), side }
      const composing = composer?.line === target.line && composer.side === target.side
      return { side: SIDE_TO_PIERRE[side], lineNumber: target.line, metadata: { kind: 'thread', comments: thread, composing, target } }
    })
    if (composer && !grouped.has(`${composer.side}:${composer.line}`)) {
      annotations.push({ side: SIDE_TO_PIERRE[composer.side], lineNumber: composer.line, metadata: { kind: 'composer', target: composer } })
    }
    return annotations
  }, [comments, composer])

  return (
    <div ref={container}>
    <DiffView<AnnotationPayload>
      patch={patch}
      mode={mode}
      colorMode={theme}
      lineAnnotations={lineAnnotations}
      onGutterUtilityClick={(range: SelectedLineRange) => setComposer({ line: range.start, side: range.side === 'deletions' ? 'old' : 'new' })}
      renderHeaderMetadata={() => headerExtra}
      renderAnnotation={(annotation) => {
        const payload = annotation.metadata
        if (!payload) return null
        const composerNode = <CommentComposer target={payload.target} onSubmit={(text) => submit(payload.target, text)} onDone={() => setComposer(undefined)} />
        if (payload.kind === 'composer') return composerNode
        return (
          <div>
            <CommentThread worktreeId={worktreeId} comments={payload.comments} />
            {payload.composing ? composerNode : null}
          </div>
        )
      }}
    />
    </div>
  )
}
