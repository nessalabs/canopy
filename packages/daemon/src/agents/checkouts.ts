/**
 * Every directory a project's agent sessions may be filed under: the main checkout, each live
 * worktree, and the worktrees that are gone.
 *
 * Providers file a session by the directory it ran in, and deleting a worktree does not delete
 * its sessions — `~/.claude/projects/<munged cwd>` and Codex's rollouts stay — but it does delete
 * the only thing that pointed Canopy at them. Two sources bring them back:
 *
 *   - `project_checkouts`, which triggers fill from every worktree row that ever existed, so any
 *     worktree Canopy saw is remembered with its name and branch after it is removed;
 *   - Claude Code's own store, for worktrees removed before Canopy kept that record (or never
 *     seen by it): a store directory whose name starts like the project's paths is read for the
 *     cwd its sessions recorded, and kept when that cwd provably belongs to the project.
 *
 * Nothing here runs at boot. The store scan runs on the first listing that asks and is reused
 * for a minute; the table reads are single queries.
 */
import { existsSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import type { Database } from 'better-sqlite3'

import { projectDirName, type Project } from '@canopy/shared'

import type { GitRunner } from '../git/exec'
import { now } from '../lib/ids'

export interface ProjectCheckout {
  path: string
  name: string
  branch: string | null
  /** `removed`: no checkout on disk any more; its sessions are still readable and resumable. */
  kind: 'main' | 'worktree' | 'removed'
  /** The live worktree this path is (or is inside of). */
  worktreeId?: string
}

/** A store scan is reused this long; worktrees are not removed every few seconds. */
export const SCAN_TTL_MS = 60_000
/** How much of a session file is read looking for the cwd it recorded. */
const HEAD_BYTES = 256 * 1024

/** Claude Code's directory name for a cwd under `~/.claude/projects`. */
export const claudeProjectKey = (path: string): string => path.replace(/[^a-zA-Z0-9]/g, '-')

interface Deps {
  db: Database
  git: GitRunner
  /** Where the managed worktrees of every project live (`<root>/<project>/worktrees/<name>`). */
  worktreeRoot: string
  /** Claude Code's session store; tests point it at a fixture. */
  claudeProjects?: string
}

interface WorktreeRowLite {
  id: string
  path: string
  name: string
  branch: string | null
  is_main: number
}

export class ProjectCheckouts {
  private readonly scans = new Map<string, { at: number; value: Promise<ProjectCheckout[]> }>()
  private readonly commonDirs = new Map<string, Promise<string | undefined>>()
  private readonly claudeProjects: string

  constructor(private readonly deps: Deps) {
    this.claudeProjects = deps.claudeProjects ?? join(homedir(), '.claude', 'projects')
  }

  /** Main first, then live worktrees, then removed ones, most recently removed first. */
  async list(project: Pick<Project, 'id' | 'path' | 'name'>): Promise<ProjectCheckout[]> {
    const live = this.deps.db
      .prepare('SELECT id, path, name, branch, is_main FROM worktrees WHERE project_id = ? AND missing = 0 ORDER BY is_main DESC, name')
      .all(project.id) as WorktreeRowLite[]
    const checkouts: ProjectCheckout[] = live.map((row) => ({ path: row.path, name: row.name, branch: row.branch, kind: row.is_main ? 'main' : 'worktree', worktreeId: row.id }))
    const known = new Set(checkouts.map((c) => c.path))

    const removed = this.deps.db
      .prepare('SELECT path, name, branch FROM project_checkouts WHERE project_id = ? AND removed_at IS NOT NULL ORDER BY removed_at DESC')
      .all(project.id) as Array<{ path: string; name: string; branch: string | null }>
    for (const row of removed) {
      if (known.has(row.path)) continue
      known.add(row.path)
      checkouts.push({ ...row, kind: 'removed' })
    }

    for (const found of await this.scan(project, live)) {
      if (known.has(found.path)) continue
      known.add(found.path)
      checkouts.push(found)
    }
    return checkouts
  }

  private scan(project: Pick<Project, 'id' | 'path' | 'name'>, live: WorktreeRowLite[]): Promise<ProjectCheckout[]> {
    const at = now()
    const hit = this.scans.get(project.id)
    if (hit && at - hit.at < SCAN_TTL_MS) return hit.value
    const value = this.scanStore(project, live).catch(() => [])
    this.scans.set(project.id, { at, value })
    return value
  }

  /**
   * Store directories that could hold this project's sessions, by name: the munged main path
   * followed by `-` covers `<repo>/.worktrees/x`, `<repo>.x` and subdirectories alike — and also
   * `<repo>-other`, a different repository, which is why each candidate's recorded cwd is checked.
   */
  private async scanStore(project: Pick<Project, 'id' | 'path' | 'name'>, live: WorktreeRowLite[]): Promise<ProjectCheckout[]> {
    let names: string[]
    try {
      names = await readdir(this.claudeProjects)
    } catch {
      return []
    }
    const managedRoot = join(this.deps.worktreeRoot, projectDirName(project.name), 'worktrees')
    const prefixes = [claudeProjectKey(project.path), claudeProjectKey(managedRoot)].map((key) => `${key}-`)
    const liveKeys = new Set(live.map((row) => claudeProjectKey(row.path)))
    const candidates = names.filter((name) => !liveKeys.has(name) && prefixes.some((prefix) => name.startsWith(prefix)))

    const found = await Promise.all(
      candidates.map(async (name): Promise<ProjectCheckout | undefined> => {
        const cwd = await recordedCwd(join(this.claudeProjects, name))
        if (!cwd || claudeProjectKey(cwd) !== name) return undefined
        if (!(await this.belongs(project, managedRoot, cwd))) return undefined
        // A directory still there is (inside) a live checkout — a subdirectory the session started
        // in. One that is gone was a worktree, even when it sat inside the main checkout.
        const container = existsSync(cwd) ? live.filter((row) => cwd === row.path || cwd.startsWith(`${row.path}/`)).sort((a, b) => b.path.length - a.path.length)[0] : undefined
        if (container) return { path: cwd, name: container.name, branch: container.branch, kind: container.is_main ? 'main' : 'worktree', worktreeId: container.id }
        return { path: cwd, name: basename(cwd), branch: null, kind: 'removed' }
      })
    )
    return found.filter((c): c is ProjectCheckout => c !== undefined)
  }

  /**
   * Whether a directory is (or was) a checkout of this project. One that still exists answers
   * through git: same common directory, same repository. One that is gone can only be judged by
   * where it was — inside the main checkout (`.worktrees/x`), beside it as `<repo>.x`, or under
   * the project's managed worktree root — which is where every worktree tool puts them.
   */
  private async belongs(project: Pick<Project, 'path'>, managedRoot: string, cwd: string): Promise<boolean> {
    const target = resolve(cwd)
    if (existsSync(target)) {
      const [mine, theirs] = await Promise.all([this.commonDir(project.path), this.commonDir(target)])
      return mine !== undefined && mine === theirs
    }
    // Under the managed root only a direct child is a worktree; deeper is something inside one.
    const managed = target.startsWith(`${managedRoot}/`) && !target.slice(managedRoot.length + 1).includes('/')
    return managed || target.startsWith(`${project.path}/`) || target.startsWith(`${project.path}.`)
  }

  private commonDir(path: string): Promise<string | undefined> {
    let value = this.commonDirs.get(path)
    if (!value) {
      value = this.deps
        .git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
        .then((out) => out.trim() || undefined)
        .catch(() => undefined)
      this.commonDirs.set(path, value)
    }
    return value
  }
}

/** The cwd the newest session in a store directory recorded, from the first lines that carry one. */
async function recordedCwd(dir: string): Promise<string | undefined> {
  let files: string[]
  try {
    files = (await readdir(dir)).filter((file) => file.endsWith('.jsonl'))
  } catch {
    return undefined
  }
  const dated = await Promise.all(files.map(async (file) => ({ file, at: await stat(join(dir, file)).then((s) => s.mtimeMs, () => 0) })))
  for (const { file } of dated.sort((a, b) => b.at - a.at).slice(0, 3)) {
    const cwd = await cwdIn(join(dir, file))
    if (cwd) return cwd
  }
  return undefined
}

async function cwdIn(file: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(file, 'r')
    const buffer = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n')
    // The last line may be cut mid-record; JSON.parse drops it.
    for (const line of lines) {
      if (!line.includes('"cwd"')) continue
      try {
        const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd
        if (typeof cwd === 'string' && cwd.startsWith('/')) return cwd
      } catch {
        // A partial line; keep looking.
      }
    }
    return undefined
  } catch {
    return undefined
  } finally {
    await handle?.close()
  }
}
