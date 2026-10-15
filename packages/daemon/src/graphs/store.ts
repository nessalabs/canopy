import type { Database } from 'better-sqlite3'

import { CONTAINS, GraphPreset, GraphScope, ReviewGraph, type GraphPatch, type GraphRecord, type HunkRef, type ReviewEdge, type ReviewNode, type SessionRef } from '@canopy/shared'

import { notFound } from '../lib/errors'
import { newId, now } from '../lib/ids'
import type { WorktreesService } from '../worktrees/service'

/** The graphs made of each worktree's change, newest first. */

interface GraphRow {
  id: string
  scope_json: string
  preset: string
  instructions: string
  before_tree: string
  after_tree: string
  ids_json: string
  lines_json: string | null
  fingerprint: string
  pr_number: number | null
  head_sha: string | null
  provider: SessionRef['provider'] | null
  session_id: string | null
  result_json: string | null
  created_at: number
}

const parse = (json: string | null): unknown => {
  try {
    return json === null ? undefined : JSON.parse(json)
  } catch {
    return undefined
  }
}

function toRecord(row: GraphRow): GraphRecord {
  // A stored answer that no longer parses is dropped rather than failing the whole list.
  const result = ReviewGraph.safeParse(parse(row.result_json)).data
  return {
    id: row.id,
    scope: GraphScope.safeParse(parse(row.scope_json)).data ?? { kind: 'uncommitted' },
    preset: GraphPreset.safeParse(row.preset).data ?? 'features',
    instructions: row.instructions,
    before: row.before_tree,
    after: row.after_tree,
    ids: JSON.parse(row.ids_json) as Record<string, HunkRef>,
    lines: (parse(row.lines_json) as Record<string, [number, number]> | undefined) ?? {},
    fingerprint: row.fingerprint,
    ...(row.pr_number !== null ? { prNumber: row.pr_number } : {}),
    ...(row.head_sha ? { headSha: row.head_sha } : {}),
    ...(row.provider && row.session_id ? { session: { provider: row.provider, sessionId: row.session_id } } : {}),
    ...(result ? { result } : {}),
    createdAt: row.created_at
  }
}

/** A graph as the brief makes it: everything but what its conversation later supplies. */
export type NewGraph = Omit<GraphRecord, 'id' | 'session' | 'result' | 'createdAt'>

/* -------------------- groupings made before graphs existed -------------------- */

interface OldPart {
  id: string
  title: string
  summary: string
  layers: string[]
  refs: HunkRef[]
}
interface OldGroups {
  groups: Array<OldPart & { parts?: OldPart[] }>
  links?: Array<{ from: string; to: string; label?: string }>
  fingerprint: string
}

/** A grouping's answer as a graph: features and their parts as nodes nested by `contains`, links turned round into `builds-on`. */
export function graphFromGrouping(old: OldGroups): ReviewGraph {
  const nodes: ReviewNode[] = []
  const edges: ReviewEdge[] = []
  const node = (part: OldPart, kind: string): ReviewNode => ({ id: part.id, kind, title: part.title, summary: part.summary, layers: part.layers, refs: part.refs, commits: [] })
  for (const group of old.groups) {
    nodes.push(node(group, group.id === 'rest' ? 'other' : 'feature'))
    for (const part of group.parts ?? []) {
      nodes.push(node(part, 'sub-feature'))
      edges.push({ from: group.id, to: part.id, kind: CONTAINS })
    }
  }
  // A grouping's link ran from the feature built on to the one building on it; an edge reads "from builds-on to".
  for (const link of old.links ?? []) edges.push({ from: link.to, to: link.from, kind: 'builds-on', ...(link.label ? { label: link.label } : {}) })
  return { nodes, edges, fingerprint: old.fingerprint }
}

interface GroupingRow {
  id: string
  worktree_id: string
  against: 'head' | 'base'
  instructions: string
  before_tree: string
  after_tree: string
  ids_json: string
  fingerprint: string
  provider: string | null
  session_id: string | null
  result_json: string | null
  created_at: number
}

interface Deps {
  db: Database
  worktrees: Pick<WorktreesService, 'row'>
}

export class GraphStore {
  constructor(private readonly deps: Deps) {
    this.adoptGroupings()
  }

  private get db(): Database {
    return this.deps.db
  }

  /**
   * Groupings kept before graphs existed become graphs of the same change, so a review in
   * progress still opens. Each is moved once: converted, written, and its old row removed.
   */
  private adoptGroupings(): void {
    const exists = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'change_groupings'").get()
    if (!exists) return
    const rows = this.db.prepare('SELECT * FROM change_groupings').all() as GroupingRow[]
    if (rows.length === 0) return
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO review_graphs (id, worktree_id, scope_json, preset, instructions, before_tree, after_tree, ids_json, fingerprint, provider, session_id, result_json, created_at)
       VALUES (?, ?, ?, 'features', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const drop = this.db.prepare('DELETE FROM change_groupings WHERE id = ?')
    this.db.transaction(() => {
      for (const row of rows) {
        const old = parse(row.result_json) as OldGroups | undefined
        const result = old && Array.isArray(old.groups) ? JSON.stringify(graphFromGrouping(old)) : null
        const scope = JSON.stringify({ kind: row.against === 'base' ? 'branch' : 'uncommitted' })
        insert.run(row.id, row.worktree_id, scope, row.instructions, row.before_tree, row.after_tree, row.ids_json, row.fingerprint, row.provider, row.session_id, result, row.created_at)
        drop.run(row.id)
      }
    })()
  }

  list(worktreeId: string): GraphRecord[] {
    this.deps.worktrees.row(worktreeId)
    const rows = this.db.prepare('SELECT * FROM review_graphs WHERE worktree_id = ? ORDER BY created_at DESC, rowid DESC').all(worktreeId) as GraphRow[]
    return rows.map(toRecord)
  }

  get(worktreeId: string, id: string): GraphRecord {
    const row = this.db.prepare('SELECT * FROM review_graphs WHERE worktree_id = ? AND id = ?').get(worktreeId, id) as GraphRow | undefined
    if (!row) throw notFound('graph', id)
    return toRecord(row)
  }

  add(worktreeId: string, graph: NewGraph): GraphRecord {
    this.deps.worktrees.row(worktreeId)
    const id = newId()
    this.db
      .prepare(
        `INSERT INTO review_graphs (id, worktree_id, scope_json, preset, instructions, before_tree, after_tree, ids_json, lines_json, fingerprint, pr_number, head_sha, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        worktreeId,
        JSON.stringify(graph.scope),
        graph.preset,
        graph.instructions,
        graph.before,
        graph.after,
        JSON.stringify(graph.ids),
        JSON.stringify(graph.lines ?? {}),
        graph.fingerprint,
        graph.prNumber ?? null,
        graph.headSha ?? null,
        now()
      )
    return this.get(worktreeId, id)
  }

  /** Fields the patch leaves out keep their value. */
  update(worktreeId: string, id: string, patch: GraphPatch): GraphRecord {
    const current = this.get(worktreeId, id)
    const session = patch.session ?? current.session
    const result = patch.result ?? current.result
    this.db
      .prepare('UPDATE review_graphs SET provider = ?, session_id = ?, result_json = ? WHERE id = ? AND worktree_id = ?')
      .run(session?.provider ?? null, session?.sessionId ?? null, result ? JSON.stringify(result) : null, id, worktreeId)
    return this.get(worktreeId, id)
  }

  remove(worktreeId: string, id: string): void {
    this.get(worktreeId, id)
    this.db.prepare('DELETE FROM review_graphs WHERE id = ? AND worktree_id = ?').run(id, worktreeId)
  }
}
