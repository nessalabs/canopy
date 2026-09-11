/**
 * Where each agent session has been working, from its hooks.
 *
 * A session is listed under the worktree it was started in, and that is usually right — but not
 * always: a session started in the main checkout that is told "work in the feature worktree"
 * spends its whole life editing files somewhere else. The hooks see every tool call, and every
 * tool call names the paths it touches, so this records each (session, worktree) pair the calls
 * reveal. The worktree's Agent tab lists those sessions next to its own.
 */
import { resolve } from 'node:path'

import type { Database } from 'better-sqlite3'

import type { AgentProvider } from '@canopy/shared'

import type { EventBus } from '../env/types'
import { now } from '../lib/ids'
import type { WorktreeRow, WorktreesService } from '../worktrees/service'
import type { ClaudeHookPayload } from './edit-diffs/hook'
import { claudeWrittenFiles } from './edit-diffs/written-files'

export interface SessionPresence {
  provider: AgentProvider
  sessionId: string
  worktreeId: string
  /** The session's own working directory. */
  cwd: string
  firstAt: number
  lastAt: number
}

interface Row {
  provider: string
  session_id: string
  worktree_id: string
  cwd: string
  first_at: number
  last_at: number
}

const toPresence = (row: Row): SessionPresence => ({
  provider: row.provider as AgentProvider,
  sessionId: row.session_id,
  worktreeId: row.worktree_id,
  cwd: row.cwd,
  firstAt: row.first_at,
  lastAt: row.last_at
})

/** A path is "mentioned" when it appears whole: `…/trash` must not claim `…/trash-2`. */
const mentions = (text: string, path: string): boolean => {
  let from = 0
  for (;;) {
    const at = text.indexOf(path, from)
    if (at < 0) return false
    const next = text[at + path.length]
    if (next === undefined || !/[A-Za-z0-9_.-]/.test(next)) return true
    from = at + 1
  }
}

interface Deps {
  db: Database
  worktrees: WorktreesService
  events: EventBus
}

export class PresenceService {
  constructor(private readonly deps: Deps) {}

  /**
   * The worktrees one tool call reaches: the session's own, whichever holds a file the call
   * writes, and any whose path the call's arguments name outright — `cd <worktree> && npm test`
   * is working there as surely as an edit is.
   */
  worktreesTouched(payload: ClaudeHookPayload): WorktreeRow[] {
    const { worktrees } = this.deps
    const found = new Map<string, WorktreeRow>()
    const add = (row: WorktreeRow | undefined): void => {
      if (row) found.set(row.id, row)
    }
    add(worktrees.containing(payload.cwd))
    for (const file of claudeWrittenFiles(payload.tool_name, payload.tool_input, payload.cwd)) add(worktrees.containing(resolve(payload.cwd, file)))
    const text = JSON.stringify(payload.tool_input ?? null)
    for (const row of worktrees.present()) if (mentions(text, row.path)) add(row)
    return [...found.values()]
  }

  /** One hook event; unknown directories cost one lookup and store nothing. */
  record(payload: ClaudeHookPayload): void {
    const touched = this.worktreesTouched(payload)
    if (touched.length === 0) return
    const at = now()
    const upsert = this.deps.db.prepare(
      `INSERT INTO agent_session_worktrees (provider, session_id, worktree_id, cwd, first_at, last_at)
       VALUES ('claude', ?, ?, ?, ?, ?)
       ON CONFLICT (provider, session_id, worktree_id) DO UPDATE SET last_at = excluded.last_at, cwd = excluded.cwd`
    )
    const appeared: string[] = []
    this.deps.db.transaction(() => {
      for (const worktree of touched) {
        if (!this.known('claude', payload.session_id, worktree.id)) appeared.push(worktree.id)
        upsert.run(payload.session_id, worktree.id, resolve(payload.cwd), at, at)
      }
    })()
    // A session showing up in a worktree for the first time is news the tab should not wait a poll
    // for; a session carrying on where it was is not.
    for (const worktreeId of appeared) this.deps.events.emit({ type: 'agent-sessions-changed', worktreeId })
  }

  private known(provider: string, sessionId: string, worktreeId: string): boolean {
    return this.deps.db.prepare('SELECT 1 FROM agent_session_worktrees WHERE provider = ? AND session_id = ? AND worktree_id = ?').get(provider, sessionId, worktreeId) !== undefined
  }

  /** Every session that has worked in this worktree, latest first. */
  sessionsIn(worktreeId: string): SessionPresence[] {
    const rows = this.deps.db.prepare('SELECT * FROM agent_session_worktrees WHERE worktree_id = ? ORDER BY last_at DESC').all(worktreeId) as Row[]
    return rows.map(toPresence)
  }

  /** When the session's hooks last reported anything, in any worktree. */
  lastSeen(provider: AgentProvider, sessionId: string): number | undefined {
    const row = this.deps.db.prepare('SELECT MAX(last_at) AS at FROM agent_session_worktrees WHERE provider = ? AND session_id = ?').get(provider, sessionId) as { at: number | null }
    return row.at ?? undefined
  }
}
