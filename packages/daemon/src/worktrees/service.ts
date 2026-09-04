import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'

import type { Database } from 'better-sqlite3'

import type { CreateWorktreeInput, Project, Worktree, WorktreeState, WorktreeStatus } from '@canopy/shared'

import type { Repo } from '../git/repo'
import { conflict, notFound } from '../lib/errors'
import { newId, now } from '../lib/ids'
import type { ProjectsService } from '../projects/service'

export interface WorktreeRow {
  id: string
  project_id: string
  name: string
  path: string
  branch: string | null
  base_branch: string | null
  is_main: number
  managed: number
  missing: number
}

interface Deps {
  db: Database
  repo: Repo
  projects: ProjectsService
  worktreeRoot: string
}

const stateOf = (row: WorktreeRow, status: WorktreeStatus | null): WorktreeState =>
  row.missing ? 'missing' : row.branch === null ? 'detached' : status && status.dirtyTotal > 0 ? 'dirty' : 'clean'

/**
 * Worktrees are whatever `git worktree list` says, persisted by path so comments and
 * pins survive across daemon restarts. Rows git no longer lists are flagged `missing`.
 */
export class WorktreesService {
  constructor(private readonly deps: Deps) {}

  private get db(): Database {
    return this.deps.db
  }

  row(id: string): WorktreeRow {
    const row = this.db.prepare('SELECT * FROM worktrees WHERE id = ?').get(id) as WorktreeRow | undefined
    if (!row) throw notFound('worktree', id)
    return row
  }

  /** The worktree whose checkout holds `cwd` (deepest match), or undefined when Canopy does not manage it. */
  containing(cwd: string): WorktreeRow | undefined {
    const rows = this.db.prepare('SELECT * FROM worktrees WHERE missing = 0 ORDER BY length(path) DESC').all() as WorktreeRow[]
    return rows.find((row) => cwd === row.path || cwd.startsWith(`${row.path}/`))
  }

  /** Path is the identity; the project's git decides what exists. */
  async sync(project: Project): Promise<WorktreeRow[]> {
    const records = await this.deps.repo.worktreeList(project.path)
    const upsert = this.db.prepare(
      `INSERT INTO worktrees (id, project_id, name, path, branch, base_branch, is_main, managed, missing, created_at, updated_at)
       VALUES (@id, @projectId, @name, @path, @branch, @baseBranch, @isMain, 0, 0, @at, @at)
       ON CONFLICT(path) DO UPDATE SET branch = excluded.branch, is_main = excluded.is_main, missing = 0, updated_at = excluded.updated_at`
    )
    const at = now()
    this.db.transaction(() => {
      records.forEach((record, index) =>
        upsert.run({
          id: newId(),
          projectId: project.id,
          name: index === 0 ? basename(record.path) : basename(record.path),
          path: record.path,
          branch: record.branch,
          baseBranch: project.defaultBase,
          isMain: index === 0 ? 1 : 0,
          at
        })
      )
      const paths = records.map((r) => r.path)
      this.db
        .prepare(`UPDATE worktrees SET missing = 1 WHERE project_id = ? AND path NOT IN (${paths.map(() => '?').join(',') || "''"})`)
        .run(project.id, ...paths)
    })()
    return this.db.prepare('SELECT * FROM worktrees WHERE project_id = ? ORDER BY is_main DESC, name').all(project.id) as WorktreeRow[]
  }

  async status(row: WorktreeRow, base: string): Promise<WorktreeStatus | null> {
    if (row.missing || !existsSync(row.path)) return null
    const [counts, aheadBehind, lastCommit] = await Promise.all([
      this.deps.repo.status(row.path),
      this.deps.repo.aheadBehind(row.path, base),
      this.deps.repo.lastCommit(row.path)
    ])
    return {
      head: counts.head,
      ahead: aheadBehind?.ahead ?? null,
      behind: aheadBehind?.behind ?? null,
      staged: counts.staged,
      unstaged: counts.unstaged,
      untracked: counts.untracked,
      conflicted: counts.conflicted,
      dirtyTotal: counts.staged + counts.unstaged + counts.untracked + counts.conflicted,
      lastCommit
    }
  }

  async toWorktree(row: WorktreeRow, project: Project): Promise<Worktree> {
    const baseBranch = row.base_branch ?? project.defaultBase
    const status = await this.status(row, baseBranch)
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      path: row.path,
      branch: row.branch,
      baseBranch,
      isMain: row.is_main === 1,
      managed: row.managed === 1,
      state: stateOf(row, status),
      status
    }
  }

  async listForProject(project: Project): Promise<Worktree[]> {
    const rows = await this.sync(project)
    return Promise.all(rows.map((row) => this.toWorktree(row, project)))
  }

  async listAll(): Promise<Worktree[]> {
    const lists = await Promise.all(this.deps.projects.list().map((project) => this.listForProject(project)))
    return lists.flat()
  }

  async get(id: string): Promise<Worktree> {
    const row = this.row(id)
    return this.toWorktree(row, this.deps.projects.get(row.project_id))
  }

  async create(project: Project, input: CreateWorktreeInput): Promise<Worktree> {
    const path = join(this.deps.worktreeRoot, project.name, input.name)
    if (existsSync(path)) throw conflict('worktree_exists', `${path} already exists`)
    await this.deps.repo.worktreeAdd(project.path, path, input.branch)
    await this.sync(project)
    this.db
      .prepare('UPDATE worktrees SET name = ?, managed = 1, base_branch = ? WHERE path = ?')
      .run(input.name, input.branch.mode === 'new' ? input.branch.base : project.defaultBase, path)
    const row = this.db.prepare('SELECT * FROM worktrees WHERE path = ?').get(path) as WorktreeRow
    return this.toWorktree(row, project)
  }

  async destroy(id: string, force: boolean): Promise<void> {
    const row = this.row(id)
    if (row.is_main) throw conflict('cannot_destroy_main', 'the primary checkout cannot be destroyed')
    const project = this.deps.projects.get(row.project_id)
    if (!row.missing && existsSync(row.path)) {
      const status = await this.status(row, project.defaultBase)
      if (status && status.dirtyTotal > 0 && !force) {
        throw conflict('worktree_dirty', `${row.name} has ${status.dirtyTotal} uncommitted change(s); pass force=true`, status)
      }
      await this.deps.repo.worktreeRemove(project.path, row.path, force)
    }
    this.db.prepare('DELETE FROM worktrees WHERE id = ?').run(id)
  }
}
