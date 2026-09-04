/**
 * Read/write operations on a git checkout. Thin: each function is one git command
 * plus a parser from parse.ts. `run` is injected so tests can observe or stub calls.
 */
import type { Branch, Commit } from '@canopy/shared'

import type { GitRunner } from './exec'
import {
  COMMIT_FORMAT,
  parseAheadBehind,
  parseBranches,
  parseLogZ,
  parsePorcelainV2,
  parseWorktreeList,
  splitNul,
  type StatusCounts,
  type WorktreeRecord
} from './parse'

export interface Repo {
  toplevel(path: string): Promise<string | null>
  listBranches(repo: string): Promise<Branch[]>
  defaultBranch(repo: string, branches: Branch[]): Promise<string>
  worktreeList(repo: string): Promise<WorktreeRecord[]>
  status(cwd: string): Promise<StatusCounts>
  aheadBehind(cwd: string, base: string): Promise<{ ahead: number; behind: number } | null>
  lastCommit(cwd: string): Promise<Commit | null>
  mergeBase(cwd: string, base: string): Promise<string | null>
  /** The commit a revision names, or null when it does not exist (e.g. HEAD on an unborn branch). */
  resolveCommit(cwd: string, rev: string): Promise<string | null>
  log(cwd: string, limit: number, skip: number): Promise<{ commits: Commit[]; hasMore: boolean }>
  commit(cwd: string, sha: string): Promise<Commit | null>
  untracked(cwd: string): Promise<string[]>
  /** Every tracked or untracked (not ignored) file under `dir`; '' for the whole tree. */
  lsFiles(cwd: string, dir: string): Promise<string[]>
  /** A file's blob at `rev`, or null when it does not exist there. */
  showFile(cwd: string, rev: string, path: string): Promise<string | null>
  worktreeAdd(repo: string, path: string, branch: { mode: 'new'; name: string; base: string } | { mode: 'existing'; name: string }): Promise<void>
  worktreeRemove(repo: string, path: string, force: boolean): Promise<void>
}

const WORKTREE_ADD_ARGS = {
  new: (path: string, b: { name: string; base: string }) => ['worktree', 'add', '-b', b.name, path, b.base],
  existing: (path: string, b: { name: string }) => ['worktree', 'add', path, b.name]
} as const

export function createRepo(run: GitRunner): Repo {
  const tryRun = async (cwd: string, args: string[]): Promise<string | null> => {
    try {
      return await run(cwd, args)
    } catch {
      return null
    }
  }

  return {
    async toplevel(path) {
      const out = await tryRun(path, ['rev-parse', '--show-toplevel'])
      return out?.trim() || null
    },

    async listBranches(repo) {
      const out = await run(repo, [
        'for-each-ref',
        '--format=%(refname:short)%00%(objectname:short)%00%(committerdate:unix)%00%(HEAD)',
        'refs/heads'
      ])
      return parseBranches(out)
    },

    async defaultBranch(repo, branches) {
      const upstream = await tryRun(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
      const fromUpstream = upstream?.trim().replace(/^origin\//, '')
      const names = new Set(branches.map((b) => b.name))
      return [fromUpstream, 'main', 'master'].find((name) => name && names.has(name)) ?? branches[0]?.name ?? 'main'
    },

    async worktreeList(repo) {
      return parseWorktreeList(await run(repo, ['worktree', 'list', '--porcelain', '-z']))
    },

    async status(cwd) {
      return parsePorcelainV2(await run(cwd, ['status', '--porcelain=v2', '--branch', '-z']))
    },

    async aheadBehind(cwd, base) {
      const out = await tryRun(cwd, ['rev-list', '--left-right', '--count', `${base}...HEAD`])
      return out === null ? null : parseAheadBehind(out)
    },

    async lastCommit(cwd) {
      const out = await tryRun(cwd, ['log', '-1', '-z', `--format=${COMMIT_FORMAT}`])
      return out ? parseLogZ(out)[0] ?? null : null
    },

    async resolveCommit(cwd, rev) {
      const out = await tryRun(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])
      return out?.trim() || null
    },

    async mergeBase(cwd, base) {
      const out = await tryRun(cwd, ['merge-base', base, 'HEAD'])
      return out?.trim() || null
    },

    async log(cwd, limit, skip) {
      if (!(await this.resolveCommit(cwd, 'HEAD'))) return { commits: [], hasMore: false }
      const out = await run(cwd, ['log', '-z', `--format=${COMMIT_FORMAT}`, '-n', String(limit + 1), '--skip', String(skip), 'HEAD'])
      const commits = parseLogZ(out)
      return { commits: commits.slice(0, limit), hasMore: commits.length > limit }
    },

    async commit(cwd, sha) {
      const out = await tryRun(cwd, ['log', '-1', '-z', `--format=${COMMIT_FORMAT}`, sha, '--'])
      return out ? parseLogZ(out)[0] ?? null : null
    },

    async untracked(cwd) {
      return splitNul(await run(cwd, ['ls-files', '--others', '--exclude-standard', '-z']))
    },

    async lsFiles(cwd, dir) {
      return splitNul(await run(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', dir === '' ? '.' : dir]))
    },

    async showFile(cwd, rev, path) {
      return tryRun(cwd, ['show', `${rev}:${path}`])
    },

    async worktreeAdd(repo, path, branch) {
      const args = branch.mode === 'new' ? WORKTREE_ADD_ARGS.new(path, branch) : WORKTREE_ADD_ARGS.existing(path, branch)
      await run(repo, args)
    },

    async worktreeRemove(repo, path, force) {
      await run(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), path])
      await run(repo, ['worktree', 'prune'])
    }
  }
}
