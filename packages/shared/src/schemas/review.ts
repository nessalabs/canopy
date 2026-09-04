import { z } from 'zod'

import { AgentProvider, TurnOptions } from './agent'
import { Id, Millis } from './common'

export const CommentSide = z.enum(['old', 'new'])
export type CommentSide = z.infer<typeof CommentSide>

export const AddCommentInput = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  side: CommentSide,
  text: z.string().min(1),
  /** The diff line the comment is anchored to, when the client has it. */
  code: z.string().optional(),
  /** Set when the comment was left on a commit in the History view. */
  commitSha: z.string().optional()
})
export type AddCommentInput = z.infer<typeof AddCommentInput>

export const ReviewComment = AddCommentInput.extend({
  id: Id,
  worktreeId: Id,
  createdAt: Millis,
  sent: z.boolean(),
  sentSessionId: z.string().optional()
})
export type ReviewComment = z.infer<typeof ReviewComment>

export const ReviewRequest = TurnOptions.extend({
  provider: AgentProvider,
  /** `null` starts a new session with `provider`; the `session` SSE event reports its id. */
  sessionId: z.string().min(1).nullable(),
  /** Defaults to every unsent comment on the worktree. */
  commentIds: z.array(Id).optional(),
  note: z.string().optional()
})
export type ReviewRequest = z.infer<typeof ReviewRequest>
