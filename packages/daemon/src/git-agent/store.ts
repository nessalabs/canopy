import type { Database } from 'better-sqlite3'

import { ChangeGroups, type AgentSessionSummary, type Against, type ChangeGrouping, type GitAgentSession, type GroupingPatch, type HunkRef, type SessionRef } from '@canopy/shared'

import { notFound } from '../lib/errors'
import { newId, now } from '../lib/ids'
import type { WorktreesService } from '../worktrees/service'

/**
 * What the Git Agent keeps per worktree beyond a page's life: which conversations it had, so its
 * history can reopen them, and the groupings of the change it was asked for.
 */

interface GroupingRow {
  id: string
  against: Against
  instructions: string
  before_tree: string
  after_tree: string
  ids_json: string
  fingerprint: string
  provider: SessionRef['provider'] | null
  session_id: string | null
  result_json: string | null
  created_at: number
}

function toGrouping(row: GroupingRow): ChangeGrouping {
  // A stored answer that no longer parses is dropped rather than failing the whole list.
  const result = row.result_json === null ? undefined : ChangeGroups.safeParse(JSON.parse(row.result_json)).data
  return {
    id: row.id,
    against: row.against,
    instructions: row.instructions,
    before: row.before_tree,
    after: row.after_tree,
    ids: JSON.parse(row.ids_json) as Record<string, HunkRef>,
    fingerprint: row.fingerprint,
    ...(row.provider && row.session_id ? { session: { provider: row.provider, sessionId: row.session_id } } : {}),
    ...(result ? { result } : {}),
    createdAt: row.created_at
  }
}

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

/** A grouping as the brief makes it: everything but what its conversation later supplies. */
export type NewGrouping = Omit<ChangeGrouping, 'id' | 'session' | 'result' | 'createdAt'>

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

  groupings(worktreeId: string): ChangeGrouping[] {
    this.deps.worktrees.row(worktreeId)
    const rows = this.db.prepare('SELECT * FROM change_groupings WHERE worktree_id = ? ORDER BY created_at DESC').all(worktreeId) as GroupingRow[]
    return rows.map(toGrouping)
  }

  grouping(worktreeId: string, id: string): ChangeGrouping {
    const row = this.db.prepare('SELECT * FROM change_groupings WHERE worktree_id = ? AND id = ?').get(worktreeId, id) as GroupingRow | undefined
    if (!row) throw notFound('grouping', id)
    return toGrouping(row)
  }

  addGrouping(worktreeId: string, grouping: NewGrouping): ChangeGrouping {
    this.deps.worktrees.row(worktreeId)
    const id = newId()
    this.db
      .prepare(
        `INSERT INTO change_groupings (id, worktree_id, against, instructions, before_tree, after_tree, ids_json, fingerprint, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, worktreeId, grouping.against, grouping.instructions, grouping.before, grouping.after, JSON.stringify(grouping.ids), grouping.fingerprint, now())
    return this.grouping(worktreeId, id)
  }

  /** Fields the patch leaves out keep their value. */
  updateGrouping(worktreeId: string, id: string, patch: GroupingPatch): ChangeGrouping {
    const current = this.grouping(worktreeId, id)
    const session = patch.session ?? current.session
    const result = patch.result ?? current.result
    this.db
      .prepare('UPDATE change_groupings SET provider = ?, session_id = ?, result_json = ? WHERE id = ?')
      .run(session?.provider ?? null, session?.sessionId ?? null, result ? JSON.stringify(result) : null, id)
    return this.grouping(worktreeId, id)
  }

  removeGrouping(worktreeId: string, id: string): void {
    this.grouping(worktreeId, id)
    this.db.prepare('DELETE FROM change_groupings WHERE id = ?').run(id)
  }
}
