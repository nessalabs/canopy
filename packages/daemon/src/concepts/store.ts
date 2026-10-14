import type { Database } from 'better-sqlite3'

import { ConceptGraph, type ConceptMap, type ConceptMapPatch, type ConceptSubject, type HunkRef, type SessionRef } from '@canopy/shared'

import { notFound } from '../lib/errors'
import { newId, now } from '../lib/ids'
import type { WorktreesService } from '../worktrees/service'

/** The concept maps a worktree holds, kept beyond a page's life so a half-done review survives. */

interface MapRow {
  id: string
  subject: ConceptSubject
  pr_number: number | null
  head_sha: string | null
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

function toMap(row: MapRow): ConceptMap {
  // A stored answer that no longer parses is dropped rather than failing the whole list.
  const result = row.result_json === null ? undefined : ConceptGraph.safeParse(JSON.parse(row.result_json)).data
  return {
    id: row.id,
    subject: row.subject,
    prNumber: row.pr_number,
    headSha: row.head_sha,
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

/** A map as the brief makes it: everything but what its conversation later supplies. */
export type NewConceptMap = Omit<ConceptMap, 'id' | 'session' | 'result' | 'createdAt'>

interface Deps {
  db: Database
  worktrees: Pick<WorktreesService, 'row'>
}

export class ConceptStore {
  constructor(private readonly deps: Deps) {}

  private get db(): Database {
    return this.deps.db
  }

  /** Newest first: the picker opens on the map last made. */
  list(worktreeId: string): ConceptMap[] {
    this.deps.worktrees.row(worktreeId)
    const rows = this.db.prepare('SELECT * FROM concept_maps WHERE worktree_id = ? ORDER BY created_at DESC').all(worktreeId) as MapRow[]
    return rows.map(toMap)
  }

  get(worktreeId: string, id: string): ConceptMap {
    const row = this.db.prepare('SELECT * FROM concept_maps WHERE worktree_id = ? AND id = ?').get(worktreeId, id) as MapRow | undefined
    if (!row) throw notFound('concept map', id)
    return toMap(row)
  }

  add(worktreeId: string, map: NewConceptMap): ConceptMap {
    this.deps.worktrees.row(worktreeId)
    const id = newId()
    this.db
      .prepare(
        `INSERT INTO concept_maps (id, worktree_id, subject, pr_number, head_sha, instructions, before_tree, after_tree, ids_json, fingerprint, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, worktreeId, map.subject, map.prNumber, map.headSha, map.instructions, map.before, map.after, JSON.stringify(map.ids), map.fingerprint, now())
    return this.get(worktreeId, id)
  }

  /** Fields the patch leaves out keep their value. */
  update(worktreeId: string, id: string, patch: ConceptMapPatch): ConceptMap {
    const current = this.get(worktreeId, id)
    const session = patch.session ?? current.session
    const result = patch.result ?? current.result
    this.db
      .prepare('UPDATE concept_maps SET provider = ?, session_id = ?, result_json = ? WHERE id = ? AND worktree_id = ?')
      .run(session?.provider ?? null, session?.sessionId ?? null, result ? JSON.stringify(result) : null, id, worktreeId)
    return this.get(worktreeId, id)
  }

  remove(worktreeId: string, id: string): void {
    this.get(worktreeId, id)
    this.db.prepare('DELETE FROM concept_maps WHERE id = ? AND worktree_id = ?').run(id, worktreeId)
  }
}
