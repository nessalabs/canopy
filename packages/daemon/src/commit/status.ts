/**
 * The Changes list for the working tree, built so that a checkbox can mean "this is in the index".
 *
 * The composition is the awkward part. `git status --porcelain=v2` knows what is staged but its
 * XY letters describe HEAD→index and index→worktree separately, and the letter the UI shows is
 * the *composition* of the two, which is not something you can read off them: `AD` (staged add,
 * deleted on disk) has no HEAD→worktree difference at all, `MD` is a deletion rather than a
 * modification, and XY has no letter for a type change. So the status letter and the +/- counts
 * keep coming from the diff, and status contributes only what the diff cannot know.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { ChangedFile, FileStatus, GitOperation, StagedState } from '@canopy/shared'

import { untrackedStat, type DiffReader, type ResolvedDiffSpec } from '../git/diff'
import type { StatusEntry } from '../git/parse'
import type { Repo } from '../git/repo'

/** Marker files git leaves in the worktree's git dir while a sequence is running. */
const OPERATIONS: ReadonlyArray<[GitOperation, string]> = [
  ['merge', 'MERGE_HEAD'],
  ['cherry-pick', 'CHERRY_PICK_HEAD'],
  ['revert', 'REVERT_HEAD'],
  ['rebase', 'rebase-merge'],
  ['rebase', 'rebase-apply']
]

/**
 * A linked worktree's git dir is `…/.git/worktrees/<name>`, not `<checkout>/.git`, so the marker
 * files have to be resolved through git. It never changes for a given checkout, so it is resolved
 * once — the changes list is polled every few seconds and this must not cost a process each time.
 */
const gitDirs = new Map<string, string>()

export async function gitDirOf(repo: Repo, cwd: string): Promise<string> {
  const cached = gitDirs.get(cwd)
  if (cached !== undefined) return cached
  // `--git-path .` resolves to the git dir itself, with a trailing '/.' to strip.
  const resolved = (await repo.gitPath(cwd, '.')).replace(/\/\.$/, '')
  const absolute = resolved.startsWith('/') ? resolved : join(cwd, resolved)
  gitDirs.set(cwd, absolute)
  return absolute
}

export async function operationIn(repo: Repo, cwd: string): Promise<GitOperation | null> {
  const gitDir = await gitDirOf(repo, cwd)
  return OPERATIONS.find(([, marker]) => existsSync(join(gitDir, marker)))?.[0] ?? null
}

/** X is HEAD→index, Y is index→worktree; '.' means "nothing on this side". */
export function stagedStateOf(entry: StatusEntry): StagedState {
  if (entry.x === '.' || entry.untracked) return 'unstaged'
  return entry.y === '.' ? 'staged' : 'partial'
}

const STATUS_LETTERS = new Set<string>(['A', 'M', 'D', 'T'])
const letterOf = (x: string): FileStatus => (STATUS_LETTERS.has(x) ? (x as FileStatus) : 'M')

export interface WorktreeChanges {
  files: ChangedFile[]
  branch: string | null
  operation: GitOperation | null
}

/**
 * Three git processes in parallel — status, numstat, name-status — plus a read of each untracked
 * file to count its lines. That is the same number the previous, index-blind implementation used
 * (numstat, name-status and `ls-files --others`); status replaces the `ls-files` call rather than
 * adding to it.
 */
export async function worktreeChanges(repo: Repo, diffs: DiffReader, cwd: string, spec: ResolvedDiffSpec): Promise<WorktreeChanges> {
  const [tracked, status, operation] = await Promise.all([
    diffs.trackedFiles(cwd, spec),
    repo.statusEntries(cwd),
    operationIn(repo, cwd)
  ])

  const byPath = new Map<string, ChangedFile>(tracked.map((file) => [file.path, file]))

  // Tracked entries first: a path that was `git rm --cached` is reported both as a staged
  // deletion and as untracked, and the staged deletion is the row that can be committed.
  for (const entry of status.entries) {
    if (entry.untracked) continue
    const existing = byPath.get(entry.path)
    const index = { staged: stagedStateOf(entry), conflicted: entry.conflicted, headSha: entry.headSha, indexSha: entry.indexSha }
    if (existing) {
      byPath.set(entry.path, { ...existing, ...index })
      continue
    }
    // No HEAD→worktree difference, but something is staged — a file staged and then reverted on
    // disk, or staged and then deleted. It would be committed, so it has to be visible.
    if (entry.x !== '.') {
      byPath.set(entry.path, { path: entry.path, status: letterOf(entry.x), additions: 0, deletions: 0, binary: false, ...index })
    }
  }

  const untracked = status.entries.filter((entry) => entry.untracked && !byPath.has(entry.path))
  for (const file of await Promise.all(untracked.map((entry) => untrackedStat(cwd, entry.path)))) {
    byPath.set(file.path, file)
  }

  return { files: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)), branch: status.branch, operation }
}
