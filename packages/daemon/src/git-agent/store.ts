import type { Database } from 'better-sqlite3'

import type { AgentSessionSummary, GitAgentSession, SessionRef } from '@canopy/shared'

import { now } from '../lib/ids'
import type { WorktreesService } from '../worktrees/service'

/**
 * What the Git Agent keeps per worktree beyond a page's life: which conversations it had, so its
 * history can reopen them.
 */

/** A remembered conversation, as the Git Agent's history lists it. */
export type Remembered = Pick<GitAgentSession, 'provider' | 'sessionId' | 'createdAt'>

/** Remembered conversations titled from the provider's listing; one it no longer lists keeps when it was first seen. */
export function titled(remembered: Remembered[], listed: AgentSessionSummary[]): GitAgentSession[] {
  const byRef = new Map(listed.map((session) => [`${session.provider}:${session.sessionId}`, session]))
  return remembered.map((ref) => {
    const found = byRef.get(`${ref.provider}:${ref.sessionId}`)
    return { ...ref, title: found?.title ?? '', updatedAt: found?.updatedAt ?? ref.createdAt }
  })
}

interface Deps {
  db: Database
  worktrees: Pick<WorktreesService, 'row'>
}

export class GitAgentStore {
  constructor(private readonly deps: Deps) {}

  private get db(): Database {
    return this.deps.db
  }

  /** Newest first: the history reads from the conversation last started. */
  sessions(worktreeId: string): Remembered[] {
    this.deps.worktrees.row(worktreeId)
    const rows = this.db.prepare('SELECT provider, session_id, created_at FROM git_agent_sessions WHERE worktree_id = ? ORDER BY created_at DESC').all(worktreeId) as Array<{
      provider: SessionRef['provider']
      session_id: string
      created_at: number
    }>
    return rows.map((row) => ({ provider: row.provider, sessionId: row.session_id, createdAt: row.created_at }))
  }

  /** Remembering a conversation twice keeps when it was first seen. */
  remember(worktreeId: string, ref: SessionRef): void {
    this.deps.worktrees.row(worktreeId)
    this.db.prepare('INSERT OR IGNORE INTO git_agent_sessions (worktree_id, provider, session_id, created_at) VALUES (?, ?, ?, ?)').run(worktreeId, ref.provider, ref.sessionId, now())
  }
}
