import type { Database } from 'better-sqlite3'

import type { AddCommentInput, AgentStreamEvent, ReviewComment, ReviewRequest, SessionRef, TurnOptions } from '@canopy/shared'

/** Payload kinds that count as the agent having produced review work, so its comments stay sent. */
const PRODUCED = new Set(['assistant_text', 'reasoning', 'tool_call_started', 'delta'])

/** Whether a stream event is the agent producing content (vs. session/progress/error bookkeeping). */
function producedContent(event: AgentStreamEvent): boolean {
  return event.type === 'event' && PRODUCED.has(event.event.payload.type)
}

import type { AgentRegistry } from '../agents/registry'
import { badRequest, notFound } from '../lib/errors'
import { newId, now } from '../lib/ids'
import type { WorktreesService } from '../worktrees/service'
import { formatReviewPrompt } from './review-prompt'

interface CommentRow {
  id: string
  worktree_id: string
  file: string
  line: number
  side: 'old' | 'new'
  code: string | null
  commit_sha: string | null
  text: string
  created_at: number
  sent_at: number | null
  sent_session_id: string | null
}

function toComment(row: CommentRow): ReviewComment {
  return {
    id: row.id,
    worktreeId: row.worktree_id,
    file: row.file,
    line: row.line,
    side: row.side,
    text: row.text,
    code: row.code ?? undefined,
    commitSha: row.commit_sha ?? undefined,
    createdAt: row.created_at,
    sent: row.sent_at !== null,
    sentSessionId: row.sent_session_id ?? undefined
  }
}

interface Deps {
  db: Database
  worktrees: WorktreesService
  agents: AgentRegistry
}

/** Line comments on a worktree's diff, and the "send them to the agent" verb. */
export class ReviewService {
  constructor(private readonly deps: Deps) {}

  private get db(): Database {
    return this.deps.db
  }

  list(worktreeId: string): ReviewComment[] {
    this.deps.worktrees.row(worktreeId)
    const rows = this.db.prepare('SELECT * FROM review_comments WHERE worktree_id = ? ORDER BY created_at').all(worktreeId) as CommentRow[]
    return rows.map(toComment)
  }

  add(worktreeId: string, input: AddCommentInput): ReviewComment {
    this.deps.worktrees.row(worktreeId)
    const id = newId()
    this.db
      .prepare(
        `INSERT INTO review_comments (id, worktree_id, file, line, side, code, commit_sha, text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, worktreeId, input.file, input.line, input.side, input.code ?? null, input.commitSha ?? null, input.text, now())
    return this.get(worktreeId, id)
  }

  get(worktreeId: string, id: string): ReviewComment {
    const row = this.db.prepare('SELECT * FROM review_comments WHERE worktree_id = ? AND id = ?').get(worktreeId, id) as CommentRow | undefined
    if (!row) throw notFound('comment', id)
    return toComment(row)
  }

  remove(worktreeId: string, id: string): void {
    this.get(worktreeId, id)
    this.db.prepare('DELETE FROM review_comments WHERE worktree_id = ? AND id = ?').run(worktreeId, id)
  }

  pinned(worktreeId: string): SessionRef | undefined {
    const row = this.db.prepare('SELECT provider, session_id FROM agent_session_pins WHERE worktree_id = ?').get(worktreeId) as
      | { provider: SessionRef['provider']; session_id: string }
      | undefined
    return row ? { provider: row.provider, sessionId: row.session_id } : undefined
  }

  pin(worktreeId: string, ref: SessionRef, at: number): void {
    this.deps.worktrees.row(worktreeId)
    this.db
      .prepare(
        `INSERT INTO agent_session_pins (worktree_id, provider, session_id, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(worktree_id) DO UPDATE SET provider = excluded.provider, session_id = excluded.session_id, updated_at = excluded.updated_at`
      )
      .run(worktreeId, ref.provider, ref.sessionId, at)
  }

  /**
   * Comments that went to GitHub with a review. They count as sent, so the next review — to an
   * agent or to GitHub — does not pick them up again; `label` (e.g. `github#12`) says where.
   */
  markPosted(worktreeId: string, ids: string[], label: string): void {
    const stmt = this.db.prepare("UPDATE review_comments SET sent_at = ?, sent_provider = 'github', sent_session_id = ? WHERE id = ? AND worktree_id = ?")
    const at = now()
    this.db.transaction(() => ids.forEach((id) => stmt.run(at, label, id, worktreeId)))()
  }

  private markSent(ids: string[], ref: PendingSessionRef | null): void {
    const stmt = this.db.prepare('UPDATE review_comments SET sent_at = ?, sent_provider = ?, sent_session_id = ? WHERE id = ?')
    const at = ref ? now() : null
    this.db.transaction(() => ids.forEach((id) => stmt.run(at, ref?.provider ?? null, ref?.sessionId ?? null, id)))()
  }

  /**
   * Validates and prepares the review turn: which comments, the prompt, and the session.
   * Marks them sent up front so a reload mid-stream shows the truth. Synchronous so the
   * route can reject (400) before the SSE response starts.
   */
  prepare(worktreeId: string, request: ReviewRequest): PreparedReview {
    const row = this.deps.worktrees.row(worktreeId)
    const wanted = request.commentIds ? new Set(request.commentIds) : null
    const comments = this.list(worktreeId).filter((c) => (wanted ? wanted.has(c.id) : !c.sent))
    const github = request.github ?? []
    if (comments.length === 0 && github.length === 0) throw badRequest('no_comments', 'there are no unsent comments to review')

    const ref: PendingSessionRef = { provider: request.provider, sessionId: request.sessionId }
    const ids = comments.map((c) => c.id)
    this.markSent(ids, ref)
    return {
      worktreeId,
      ref,
      ids,
      cwd: row.path,
      options: { autonomy: request.autonomy, model: request.model, effort: request.effort },
      prompt: formatReviewPrompt({ comments, github, branch: row.branch ?? undefined, note: request.note })
    }
  }

  /**
   * Streams the prepared turn. A turn into a new session learns its id from the first
   * `session` event: the comments are re-marked with it and the session pinned, so the
   * Agent tab lands on the conversation that holds the review. An error before the agent
   * produced anything un-marks the comments.
   */
  async *stream(turn: PreparedReview, signal: AbortSignal): AsyncGenerator<AgentStreamEvent> {
    let produced = false
    const rollback = (): void => {
      if (!produced) this.markSent(turn.ids, null)
    }
    const adopt = (ref: SessionRef): void => {
      if (turn.ref.sessionId !== null) return
      this.markSent(turn.ids, ref)
      this.pin(turn.worktreeId, ref, now())
    }
    try {
      const adapter = this.deps.agents.adapterFor(turn.ref.provider)
      for await (const event of adapter.send(turn.ref.sessionId, turn.prompt, { ...turn.options, cwd: turn.cwd, signal })) {
        produced ||= producedContent(event)
        if (event.type === 'session') adopt({ provider: event.provider, sessionId: event.sessionId })
        if (event.type === 'error') rollback()
        yield event
      }
    } catch (error) {
      rollback()
      throw error
    }
  }
}

/** A SessionRef whose id may still be unknown (a session the agent has yet to create). */
export type PendingSessionRef = { provider: SessionRef['provider']; sessionId: string | null }

export interface PreparedReview {
  worktreeId: string
  ref: PendingSessionRef
  ids: string[]
  cwd: string
  options: TurnOptions
  prompt: string
}
