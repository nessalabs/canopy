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

/** Set on a comment the client builds from a GitHub review thread; never stored by the daemon. */
export const GitHubOrigin = z.object({
  author: z.string(),
  url: z.string(),
  resolved: z.boolean(),
  host: z.string().nullable()
})
export type GitHubOrigin = z.infer<typeof GitHubOrigin>

export const ReviewComment = AddCommentInput.extend({
  id: Id,
  worktreeId: Id,
  createdAt: Millis,
  sent: z.boolean(),
  sentSessionId: z.string().optional(),
  github: GitHubOrigin.optional()
})

/** A GitHub review thread handed to the agent alongside (or instead of) local comments. */
export const GitHubNote = z.object({
  author: z.string(),
  /** Missing for a comment on the PR's conversation rather than on a line of its diff. */
  file: z.string().optional(),
  /** Missing for an outdated thread whose line is gone; the file still anchors it. */
  line: z.number().int().positive().optional(),
  side: CommentSide.optional(),
  /** The thread's replies, oldest first, as `author: text`. */
  body: z.string().min(1),
  url: z.string(),
  resolved: z.boolean().default(false)
})
export type GitHubNote = z.infer<typeof GitHubNote>
export type ReviewComment = z.infer<typeof ReviewComment>

export const ReviewRequest = TurnOptions.extend({
  provider: AgentProvider,
  /** `null` starts a new session with `provider`; the `session` SSE event reports its id. */
  sessionId: z.string().min(1).nullable(),
  /** Defaults to every unsent comment on the worktree. */
  commentIds: z.array(Id).optional(),
  /** GitHub review threads to include; a request may carry these and no local comments. */
  github: z.array(GitHubNote).optional(),
  note: z.string().optional()
})
export type ReviewRequest = z.infer<typeof ReviewRequest>
