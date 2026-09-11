/**
 * Landing a worktree's branch on its base. A merge needs the base branch checked out
 * somewhere — that is where git resolves it — so the base's own worktree (the primary
 * checkout, usually) does the work, and only when it has nothing uncommitted that the
 * merge could trample. A fast-forward is the exception: it moves a ref, so it can run
 * with no checkout at all through `fetch . branch:base`, which refuses anything but a
 * fast-forward and never touches a working tree.
 *
 * A merge that stops on conflicts is undone on the spot. Conflict resolution is an
 * editor-and-terminal job, and a half-merged primary checkout is the last thing anyone
 * wants to discover later; the daemon reports which files clashed and leaves the base
 * exactly as it found it.
 */
import { existsSync } from 'node:fs'

import type { MergeInput, MergeResult } from '@canopy/shared'

import type { EventBus } from '../env/types'
import type { GitRunner } from '../git/exec'
import type { Repo } from '../git/repo'
import { badRequest, conflict } from '../lib/errors'
import type { ProjectsService } from '../projects/service'
import type { WorktreesService } from './service'

/** Hooks on the base (pre-merge, post-merge, commit hooks for a squash) may be slow; they may not hang. */
const MERGE_TIMEOUT_MS = 120_000

interface Deps {
  repo: Pick<Repo, 'worktreeList' | 'status' | 'aheadBehind' | 'resolveCommit'>
  git: GitRunner
  worktrees: Pick<WorktreesService, 'row'>
  projects: Pick<ProjectsService, 'get'>
  events: EventBus
}

export class MergeService {
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(private readonly deps: Deps) {}

  /** One merge at a time per base checkout: two would race for the index and MERGE_HEAD. */
  private locked<T>(cwd: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(cwd) ?? Promise.resolve()
    const next = previous.then(work, work)
    this.locks.set(
      cwd,
      next.then(
        () => undefined,
        () => undefined
      )
    )
    return next
  }

  async merge(worktreeId: string, input: MergeInput): Promise<MergeResult> {
    const row = this.deps.worktrees.row(worktreeId)
    if (row.is_main) throw badRequest('cannot_merge_main', 'the primary checkout is the base; there is nothing to merge it into')
    if (row.branch === null) throw badRequest('detached', 'a detached worktree has no branch to merge')
    if (row.missing || !existsSync(row.path)) throw conflict('worktree_missing', `${row.name} has no checkout on disk`)
    const project = this.deps.projects.get(row.project_id)
    const base = row.base_branch ?? project.defaultBase
    const branch = row.branch
    if (branch === base) throw badRequest('same_branch', `${row.name} is on ${base} itself`)

    const aheadBehind = await this.deps.repo.aheadBehind(row.path, base)
    if (aheadBehind === null) throw conflict('base_missing', `branch ${base} does not exist`)
    if (aheadBehind.ahead === 0) throw conflict('nothing_to_merge', `${branch} has no commits that ${base} lacks`)
    if (input.strategy === 'ff' && aheadBehind.behind > 0) {
      throw conflict('not_fast_forward', `${base} has ${aheadBehind.behind} commit(s) ${branch} lacks; merge or squash instead, or rebase first`, aheadBehind)
    }

    const checkout = (await this.deps.repo.worktreeList(project.path)).find((record) => record.branch === base)
    const result = checkout
      ? await this.mergeIn(checkout.path, base, branch, input)
      : await this.fastForwardRef(project.path, base, branch, input.strategy)
    this.deps.events.emit({ type: 'worktrees-changed', projectId: project.id })
    return result
  }

  /** No checkout has the base: only a fast-forward can land without one. */
  private async fastForwardRef(repoPath: string, base: string, branch: string, strategy: MergeInput['strategy']): Promise<MergeResult> {
    if (strategy !== 'ff') throw conflict('base_not_checked_out', `${base} is not checked out in any worktree; a ${strategy} needs one, a fast-forward does not`)
    await this.deps.git(repoPath, ['fetch', '.', `${branch}:${base}`], { timeout: MERGE_TIMEOUT_MS })
    const sha = await this.deps.repo.resolveCommit(repoPath, base)
    return { sha: sha ?? '', into: base, strategy, checkout: null }
  }

  private async mergeIn(cwd: string, base: string, branch: string, input: MergeInput): Promise<MergeResult> {
    return this.locked(cwd, async () => {
      const counts = await this.deps.repo.status(cwd)
      const dirty = counts.staged + counts.unstaged + counts.conflicted
      if (dirty > 0) throw conflict('base_dirty', `the ${base} checkout has ${dirty} uncommitted change(s); commit or stash them first`, { checkout: cwd, ...counts })
      if (counts.conflicted > 0 || (await this.inOperation(cwd))) throw conflict('base_busy', `the ${base} checkout is mid-merge or mid-rebase`)

      const opts = { timeout: MERGE_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: '0' } }
      const message = input.message?.trim()
      try {
        if (input.strategy === 'ff') {
          await this.deps.git(cwd, ['merge', '--ff-only', branch], opts)
        } else if (input.strategy === 'merge') {
          await this.deps.git(cwd, ['merge', '--no-ff', ...(message ? ['-m', message] : ['--no-edit']), branch], opts)
        } else {
          await this.deps.git(cwd, ['merge', '--squash', branch], opts)
          await this.deps.git(cwd, ['commit', '--no-edit', '-m', message || `Squash ${branch}`], opts)
        }
      } catch (error) {
        const files = await this.conflictedFiles(cwd)
        await this.abort(cwd, input.strategy)
        if (files.length > 0) throw conflict('merge_conflict', `${branch} conflicts with ${base} in ${files.length} file(s); resolve it in a checkout and try again`, { files })
        throw error
      }
      const sha = await this.deps.repo.resolveCommit(cwd, 'HEAD')
      return { sha: sha ?? '', into: base, strategy: input.strategy, checkout: cwd }
    })
  }

  private async inOperation(cwd: string): Promise<boolean> {
    const out = await this.deps.git(cwd, ['rev-parse', '--git-path', 'MERGE_HEAD', '--git-path', 'rebase-merge', '--git-path', 'rebase-apply'])
    return out.split('\n').some((line) => line.trim() !== '' && existsSync(line.trim()))
  }

  private async conflictedFiles(cwd: string): Promise<string[]> {
    const out = await this.deps.git(cwd, ['diff', '--name-only', '--diff-filter=U', '-z']).catch(() => '')
    return out.split('\0').filter(Boolean)
  }

  /** Put the base checkout back the way it was: `--abort` for a real merge, a reset for a squash (no MERGE_HEAD). */
  private async abort(cwd: string, strategy: MergeInput['strategy']): Promise<void> {
    if (strategy === 'squash') await this.deps.git(cwd, ['reset', '--merge']).catch(() => undefined)
    else await this.deps.git(cwd, ['merge', '--abort']).catch(() => undefined)
  }
}
