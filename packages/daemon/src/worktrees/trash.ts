/**
 * The trash: what a destroy left behind, and how to get it back.
 *
 * Destroying a worktree that has uncommitted work saves that work as a commit under
 * `refs/canopy/salvage/` (see `WorktreesService.destroy`). Those refs are the trash — one
 * entry per worktree that went with something in it. Everything an entry needs to describe
 * itself, and to be put back, is written into the commit as trailers when it is taken, so
 * listing the trash is a single `for-each-ref` however many entries there are.
 *
 * Restoring recreates the worktree the way it was: the branch at the commit it sat on, and
 * the rescued work back in the working tree, still uncommitted. It was never committed when
 * it was lost, and coming back as a commit would be a different thing from what was taken.
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import type { Project } from '@canopy/shared'

import type { Repo } from '../git/repo'
import { conflict, notFound } from '../lib/errors'
import type { ProjectsService } from '../projects/service'

import { SALVAGE_REFS } from './service'

export interface TrashEntry {
  /** The salvage commit; unique, and safe in a URL, unlike the ref it is reached by. */
  id: string
  ref: string
  /** The destroyed worktree's name, branch and checkout, as they were. */
  name: string
  branch: string | null
  path: string
  /** The commit the worktree was sitting on: what a restore puts the branch back at. */
  base: string | null
  files: number
  destroyedAt: number
}

export interface RestorePlan {
  path: string
  branch: string | null
  base: string | null
  files: string[]
}

interface Deps {
  repo: Pick<Repo, 'refsUnder' | 'deleteRef' | 'changedPaths' | 'restoreFrom' | 'worktreeAdd' | 'resolveCommit' | 'worktreeList'>
  projects: Pick<ProjectsService, 'get'>
}

/** `Canopy-Branch: feat/x` and friends, written by the salvage that took the snapshot. */
const trailer = (message: string, name: string): string | null => new RegExp(`^${name}:[ \\t]*(.*)$`, 'm').exec(message)?.[1]?.trim() || null

export class TrashService {
  constructor(private readonly deps: Deps) {}

  async list(project: Project): Promise<TrashEntry[]> {
    const refs = await this.deps.repo.refsUnder(project.path, SALVAGE_REFS)
    return refs.map(({ ref, sha, at, message }) => ({
      id: sha,
      ref,
      // The trailers are how an entry knows what it was; a ref written by an older daemon has
      // none, so its name comes from where it was filed and the rest stays unknown.
      name: trailer(message, 'Canopy-Worktree') ?? ref.slice(SALVAGE_REFS.length + 1).replace(/-\d{4}-\d{2}-\d{2}T.*$/, ''),
      branch: trailer(message, 'Canopy-Branch'),
      path: trailer(message, 'Canopy-Path') ?? '',
      base: trailer(message, 'Canopy-Base'),
      files: Number(trailer(message, 'Canopy-Files') ?? 0),
      destroyedAt: at
    }))
  }

  async get(project: Project, id: string): Promise<TrashEntry> {
    const entry = (await this.list(project)).find((candidate) => candidate.id === id)
    if (!entry) throw notFound('trash entry', id)
    return entry
  }

  /**
   * Puts the worktree back where it was, on the branch it was on, with the rescued work
   * uncommitted in it — then drops the entry, because it is no longer in the trash. The
   * caller registers the checkout with Canopy; this only deals in git.
   */
  async restore(project: Project, id: string): Promise<RestorePlan> {
    const entry = await this.get(project, id)
    if (entry.path === '' || entry.base === null) {
      throw conflict('trash_entry_incomplete', `${entry.name} was saved by an older daemon and does not record where it lived; restore it by hand from ${entry.ref}`)
    }
    const taken = await this.deps.repo.worktreeList(project.path)
    if (taken.some((record) => record.path === entry.path)) throw conflict('path_taken', `${entry.path} is a worktree again; move or destroy it before restoring this one`)

    // The branch may still exist (the destroy kept it) or have gone with the worktree. Reusing
    // it keeps whatever it has moved on to; recreating it puts it back where the work forked.
    const branch = entry.branch
    const exists = branch !== null && (await this.deps.repo.resolveCommit(project.path, `refs/heads/${branch}`)) !== null
    const checkedOut = branch !== null && taken.some((record) => record.branch === branch)
    if (checkedOut) throw conflict('branch_checked_out', `${branch} is checked out in another worktree; restore it there or destroy that one first`)
    await this.deps.repo.worktreeAdd(project.path, entry.path, branch === null ? { mode: 'existing', name: entry.base } : exists ? { mode: 'existing', name: branch } : { mode: 'new', name: branch, base: entry.base })

    // The snapshot holds every path that existed, so writing it over the fresh checkout puts
    // the modifications and the untracked files back. What it cannot hold is what had been
    // deleted; those come back with the checkout, so they are taken out again here.
    await this.deps.repo.restoreFrom(entry.path, entry.id)
    const changed = await this.deps.repo.changedPaths(project.path, entry.base, entry.id)
    for (const change of changed.filter((candidate) => candidate.status.startsWith('D'))) {
      await rm(join(entry.path, change.path), { force: true })
    }
    await this.deps.repo.deleteRef(project.path, entry.ref)
    return { path: entry.path, branch, base: entry.base, files: changed.map((change) => change.path) }
  }

  async purge(project: Project, id: string): Promise<void> {
    await this.deps.repo.deleteRef(project.path, (await this.get(project, id)).ref)
  }
}
