import { existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import type { Database } from 'better-sqlite3'

import { emptyEnvironment, projectDirName, type CreateWorktreeInput, type Project, type Worktree, type WorktreeState, type WorktreeStatus } from '@canopy/shared'

import type { EventBus } from '../env/types'
import type { Worktrunk } from '../env/worktrunk/wt'
import type { Repo } from '../git/repo'
import { conflict, gone, notFound } from '../lib/errors'
import { newId, now } from '../lib/ids'
import type { ProjectsService } from '../projects/service'

import { MergedDetector } from './merged'

/** Where a destroyed worktree's uncommitted work is kept; `git for-each-ref` finds them all. */
export const SALVAGE_REFS = 'refs/canopy/salvage'

/** The commit a destroy left behind, so the work it discarded can be got back. */
export interface Salvage {
  ref: string
  sha: string
  files: number
}

export interface DestroyResult {
  salvaged: Salvage | null
}

/** The slice of EnvironmentService the worktree service needs; bound late because each depends on the other. */
export interface EnvironmentHooks {
  environmentOf(worktreeId: string): Worktree['environment']
  createAndProvision(project: Project, input: CreateWorktreeInput): WorktreeRow
  teardown(worktreeId: string): Promise<void>
  forget(worktreeId: string): void
  settings(projectId: string): { worktrunk: { enabled: boolean }; cleanup: { deleteBranch: 'never' | 'if-merged' | 'ask' } }
}

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
  env_state: string
}

interface Deps {
  db: Database
  repo: Repo
  projects: ProjectsService
  worktreeRoot: string
  worktrunk: Worktrunk
  events: EventBus
}

const stateOf = (row: WorktreeRow, status: WorktreeStatus | null): WorktreeState =>
  row.missing ? 'missing' : row.branch === null ? 'detached' : status && status.dirtyTotal > 0 ? 'dirty' : 'clean'

/**
 * Worktrees are whatever `git worktree list` says, persisted by path so comments and
 * pins survive across daemon restarts. A checkout git has stopped listing was removed by
 * something other than this daemon — another canopyd, a plain `git worktree remove`, a
 * prune — and its row is reaped rather than left in the list as a ghost.
 */
export class WorktreesService {
  private environment: EnvironmentHooks | null = null
  private readonly merged: MergedDetector
  /** Rows a reap is working through; the sync that lands mid-reap must not start it over. */
  private readonly reaping = new Set<string>()

  constructor(private readonly deps: Deps) {
    this.merged = new MergedDetector(deps.repo)
  }

  private get db(): Database {
    return this.deps.db
  }

  /** EnvironmentService is built after this service (it needs rows); it registers itself here. */
  attachEnvironment(environment: EnvironmentHooks): void {
    this.environment = environment
  }

  row(id: string): WorktreeRow {
    const row = this.db.prepare('SELECT * FROM worktrees WHERE id = ?').get(id) as WorktreeRow | undefined
    if (!row) throw notFound('worktree', id)
    return row
  }

  rowByPath(path: string): WorktreeRow | undefined {
    const target = path.replace(/\/$/, '')
    return this.db.prepare('SELECT * FROM worktrees WHERE path = ?').get(target) as WorktreeRow | undefined
  }

  /** The worktree whose checkout holds `cwd` (deepest match), or undefined when Canopy does not manage it. */
  containing(cwd: string): WorktreeRow | undefined {
    // Lexically canonical first: `<worktree>/../elsewhere` starts with the worktree's path and is
    // not inside it. Callers that go on to use the path must use the canonical form too.
    const target = resolve(cwd)
    const rows = this.db.prepare('SELECT * FROM worktrees WHERE missing = 0 ORDER BY length(path) DESC').all() as WorktreeRow[]
    return rows.find((row) => target === row.path || target.startsWith(`${row.path}/`))
  }

  /**
   * Path is the identity; the project's git decides what exists. A set that grew or shrank
   * since the last read is news for every client, not just the one that asked.
   */
  async sync(project: Project): Promise<WorktreeRow[]> {
    const records = await this.deps.repo.worktreeList(project.path)
    const known = new Set((this.db.prepare('SELECT path FROM worktrees WHERE project_id = ?').all(project.id) as Array<{ path: string }>).map((row) => row.path))
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
      // Rows mid-creation have no checkout yet, and rows mid-destroy are about to go: neither is "missing".
      this.db
        .prepare(`UPDATE worktrees SET missing = 1 WHERE project_id = ? AND env_state NOT IN ('creating', 'destroying') AND path NOT IN (${paths.map(() => '?').join(',') || "''"})`)
        .run(project.id, ...paths)
    })()
    const rows = this.db.prepare('SELECT * FROM worktrees WHERE project_id = ? ORDER BY is_main DESC, name').all(project.id) as WorktreeRow[]
    // Flagged just now or left over from a daemon that stopped before it could finish: either
    // way the checkout is gone. Rows mid-create and mid-destroy are never flagged, so nothing
    // on its way in or out is reaped.
    const vanished = rows.filter((row) => row.missing === 1 && !this.reaping.has(row.id))
    // The reap announces itself; an arrival from outside this daemon has no other announcement.
    // Nothing awaits it, so it must swallow its own failures: an unhandled rejection here would
    // take the daemon down over a worktree that had already gone.
    if (vanished.length > 0) void this.reap(project, vanished).catch((error: unknown) => console.error('[worktrees] reap failed:', error))
    else if (records.some((record) => !known.has(record.path))) this.deps.events.emit({ type: 'worktrees-changed', projectId: project.id })
    return rows.filter((row) => row.missing === 0)
  }

  /**
   * Drops rows whose checkout git no longer lists. The environment goes first, so the ports,
   * logs, databases and service records it was holding are released exactly as `destroy`
   * releases them; the row goes whether or not that succeeded, because a worktree that cannot
   * be torn down is still not a worktree. Runs off the sync that found them rather than inside
   * it — reading the list never waits on docker.
   */
  private async reap(project: Project, rows: WorktreeRow[]): Promise<void> {
    for (const row of rows) this.reaping.add(row.id)
    try {
      for (const row of rows) {
        try {
          await this.environment?.teardown(row.id)
        } catch (error) {
          console.error(`[worktrees] ${row.name} is gone from git but its environment would not tear down:`, error)
        }
        this.db.prepare('DELETE FROM worktrees WHERE id = ?').run(row.id)
        this.environment?.forget(row.id)
      }
    } finally {
      for (const row of rows) this.reaping.delete(row.id)
    }
    this.deps.events.emit({ type: 'worktrees-changed', projectId: project.id })
  }

  async status(row: WorktreeRow, base: string): Promise<WorktreeStatus | null> {
    if (row.missing || !existsSync(row.path)) return null
    const [counts, aheadBehind, lastCommit] = await Promise.all([
      this.deps.repo.status(row.path),
      this.deps.repo.aheadBehind(row.path, base),
      this.deps.repo.lastCommit(row.path)
    ])
    const ahead = aheadBehind?.ahead ?? null
    const behind = aheadBehind?.behind ?? null
    // The main checkout is its own base; "merged" would always be true and mean nothing.
    const merged = row.is_main || !lastCommit ? null : await this.merged.isMerged({ cwd: row.path, head: lastCommit.sha, base, ahead, behind })
    return {
      head: counts.head,
      ahead,
      behind,
      staged: counts.staged,
      unstaged: counts.unstaged,
      untracked: counts.untracked,
      conflicted: counts.conflicted,
      dirtyTotal: counts.staged + counts.unstaged + counts.untracked + counts.conflicted,
      lastCommit,
      merged
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
      status,
      environment: this.environment?.environmentOf(row.id) ?? emptyEnvironment(project.config.valid, project.config.errors)
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

  /**
   * Where a worktree lives and what it compares against — both plain columns, so this answers
   * without spawning git. Readers that only need the checkout (diffs, log, file browsing) take
   * this instead of `get`, whose status derivation costs three git processes per call.
   */
  location(id: string): { path: string; baseBranch: string; projectId: string } {
    const row = this.row(id)
    // Every reader that spawns git inside a checkout comes through here, so this is where a
    // checkout that is not there turns into an answer. Left to git it is an unspawnable
    // command, which reaches the client as "git diff exited with 1" and explains nothing.
    if (!existsSync(row.path)) {
      if (row.env_state === 'creating') throw conflict('worktree_not_ready', `${row.name} is still being created`)
      throw gone('worktree_gone', `${row.name} is no longer on disk (${row.path}); it was removed outside this daemon`)
    }
    return { path: row.path, baseBranch: row.base_branch ?? this.deps.projects.get(row.project_id).defaultBase, projectId: row.project_id }
  }

  /**
   * Registers the worktree and hands creation + provisioning to the environment pipeline, which
   * runs in the background (the row is `creating` until `wt switch` / `git worktree add` lands).
   */
  async create(project: Project, input: CreateWorktreeInput): Promise<Worktree> {
    if (this.environment) return this.toWorktree(this.environment.createAndProvision(project, input), project)
    // Without an environment service (tests of the git layer alone) fall back to a synchronous git add.
    const path = join(this.deps.worktreeRoot, projectDirName(project.name), 'worktrees', input.name)
    if (existsSync(path)) throw conflict('worktree_exists', `${path} already exists`)
    await this.deps.repo.worktreeAdd(project.path, path, input.branch)
    await this.sync(project)
    this.db
      .prepare('UPDATE worktrees SET name = ?, managed = 1, base_branch = ? WHERE path = ?')
      .run(input.name, input.branch.mode === 'new' ? input.branch.base : project.defaultBase, path)
    const row = this.db.prepare('SELECT * FROM worktrees WHERE path = ?').get(path) as WorktreeRow
    return this.toWorktree(row, project)
  }

  /**
   * Tears the environment down (services, containers, forks, ports, logs), then removes the
   * checkout through worktrunk or git. `deleteBranch` overrides the project's cleanup policy.
   *
   * Uncommitted work is saved before the checkout goes. Forcing past the dirty check is the
   * ordinary way to destroy a worktree — the UI sets `force` for you whenever there is
   * anything uncommitted — and what it discards has never been committed anywhere, so no
   * reflog, no dangling object and no `fsck` will bring it back. A commit under
   * `refs/canopy/salvage/` costs nothing and turns that into something recoverable.
   */
  async destroy(id: string, force: boolean, deleteBranch?: 'never' | 'if-merged' | 'always'): Promise<DestroyResult> {
    const row = this.row(id)
    if (row.is_main) throw conflict('cannot_destroy_main', 'the primary checkout cannot be destroyed')
    const project = this.deps.projects.get(row.project_id)
    const present = !row.missing && existsSync(row.path)
    let salvaged: Salvage | null = null
    if (present) {
      const status = await this.status(row, project.defaultBase)
      if (status && status.dirtyTotal > 0 && !force) {
        throw conflict('worktree_dirty', `${row.name} has ${status.dirtyTotal} uncommitted change(s); pass force=true`, status)
      }
      if (status && status.dirtyTotal > 0) salvaged = await this.salvage(row)
    }
    const settings = this.environment?.settings(project.id)
    const policy = deleteBranch ?? (settings?.cleanup.deleteBranch === 'if-merged' ? 'if-merged' : 'never')
    await this.environment?.teardown(id)
    if (present) {
      await this.deps.worktrunk.remove({ repoPath: project.path, path: row.path, branch: row.branch, force, deleteBranch: policy, useWt: settings?.worktrunk.enabled ?? true })
    } else {
      await this.deps.repo.worktreeRemove(project.path, row.path, true).catch(() => undefined)
    }
    this.db.prepare('DELETE FROM worktrees WHERE id = ?').run(id)
    this.environment?.forget(id)
    this.deps.events.emit({ type: 'worktrees-changed', projectId: project.id })
    return { salvaged }
  }

  /**
   * The working tree as one commit on a ref of its own, taken just before the checkout is
   * removed. Failing to save is not a reason to refuse the destroy the caller asked for, so a
   * failure is reported as "nothing saved" rather than thrown — but it is never silent.
   */
  private async salvage(row: WorktreeRow): Promise<Salvage | null> {
    const ref = `${SALVAGE_REFS}/${row.name}-${new Date().toISOString().replace(/[:.]/g, '-')}`
    try {
      // Trailers, so the trash can describe an entry and put the worktree back without a
      // record of its own: one `for-each-ref` answers the whole list.
      const head = await this.deps.repo.resolveCommit(row.path, 'HEAD')
      const message = (files: number): string =>
        [
          `canopy: uncommitted work in ${row.name} at the time it was destroyed`,
          '',
          `Canopy-Worktree: ${row.name}`,
          ...(row.branch === null ? [] : [`Canopy-Branch: ${row.branch}`]),
          `Canopy-Path: ${row.path}`,
          ...(head === null ? [] : [`Canopy-Base: ${head}`]),
          `Canopy-Files: ${files}`,
          ''
        ].join('\n')
      const snapshot = await this.deps.repo.snapshotWorkingTree(row.path, ref, message)
      return snapshot && { ref, ...snapshot }
    } catch (error) {
      console.error(`[worktrees] could not save the uncommitted work in ${row.name}:`, error)
      return null
    }
  }
}
