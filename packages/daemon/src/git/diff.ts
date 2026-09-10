/**
 * Diffs for one `ResolvedDiffSpec`. The working-tree and commit cases differ only in
 * the base git arguments (tables below); listing, numstat joining, untracked handling
 * and patch capping are shared.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { ChangedFile, FileContents, FilePatch } from '@canopy/shared'

import type { GitRunner } from './exec'
import { joinChangedFiles, parseNameStatus, parseNumstat, UNSTAGED } from './parse'

/** DiffSpec with `against` already resolved to a revision. */
export type ResolvedDiffSpec = { kind: 'worktree'; rev: string } | { kind: 'commit'; sha: string } | { kind: 'trees'; before: string; after: string }

const trees = (spec: ResolvedDiffSpec): string[] => {
  const { before, after } = spec as { before: string; after: string }
  return ['diff', before, after]
}

export const PATCH_CAP_BYTES = 512 * 1024
export const FILE_CAP_BYTES = 2 * 1024 * 1024
/** A NUL byte this early is how git itself decides a blob is binary. */
const BINARY_SNIFF_BYTES = 8 * 1024

const LIST_BASE: Record<ResolvedDiffSpec['kind'], (spec: ResolvedDiffSpec) => string[]> = {
  worktree: (spec) => ['diff', (spec as { rev: string }).rev],
  commit: (spec) => ['diff-tree', '--root', '-r', '--no-commit-id', '-m', '--first-parent', (spec as { sha: string }).sha],
  trees
}

const PATCH_BASE: Record<ResolvedDiffSpec['kind'], (spec: ResolvedDiffSpec) => string[]> = {
  worktree: (spec) => ['diff', (spec as { rev: string }).rev],
  commit: (spec) => ['show', '--format=', '--first-parent', '-m', (spec as { sha: string }).sha],
  trees
}

// Recent git defaults to mnemonic prefixes (c/ w/ i/); the diff renderer expects a/ b/.
const PREFIXES = ['--src-prefix=a/', '--dst-prefix=b/']
const PATCH_FLAGS = ['--no-color', '--no-ext-diff', '--no-renames', ...PREFIXES]
const NO_INDEX = ['diff', '--no-index', '--no-color', ...PREFIXES]

export interface DiffReader {
  files(cwd: string, spec: ResolvedDiffSpec): Promise<ChangedFile[]>
  /**
   * `files` without the untracked pass. The commit panel already learns about untracked paths
   * from `git status`, so asking git for them a second time would be a wasted process.
   */
  trackedFiles(cwd: string, spec: ResolvedDiffSpec): Promise<ChangedFile[]>
  patch(cwd: string, spec: ResolvedDiffSpec, path: string): Promise<FilePatch>
}

/** Same contract as `toFilePatch`, for whole files: text, or null when binary or over the cap. */
export function toFileContents(path: string, raw: string): FileContents {
  const size = Buffer.byteLength(raw)
  const binary = raw.slice(0, BINARY_SNIFF_BYTES).includes('\0')
  const truncated = size > FILE_CAP_BYTES
  return { path, content: binary || truncated ? null : raw, truncated, binary, size }
}

/** Lines the way git counts them: a file whose last line has no newline still ends a line. */
function countLines(raw: Buffer): number {
  if (raw.length === 0) return 0
  let lines = 0
  for (let at = raw.indexOf(10); at !== -1; at = raw.indexOf(10, at + 1)) lines += 1
  return raw[raw.length - 1] === 10 ? lines : lines + 1
}

/**
 * An untracked file's numstat, read straight off disk: every line is an addition, and a NUL
 * early in the blob is binary — the same answers `git diff --no-index` against /dev/null gives.
 * Doing it here matters because `files()` needs one per untracked path, and a checkout with a
 * few dozen new files was spawning a git process for each.
 */
export async function untrackedStat(cwd: string, path: string): Promise<ChangedFile> {
  const raw = await readFile(join(cwd, path)).catch(() => null)
  const binary = raw !== null && raw.subarray(0, BINARY_SNIFF_BYTES).includes(0)
  return { path, status: 'U', additions: raw === null || binary ? 0 : countLines(raw), deletions: 0, binary, ...UNSTAGED }
}

export function toFilePatch(path: string, raw: string): FilePatch {
  const binary = /^Binary files .* differ$/m.test(raw)
  const truncated = Buffer.byteLength(raw) > PATCH_CAP_BYTES
  return { path, patch: binary || truncated ? null : raw, truncated, binary }
}

export function createDiffReader(run: GitRunner, untracked: (cwd: string, path?: string) => Promise<string[]>): DiffReader {
  async function tracked(cwd: string, spec: ResolvedDiffSpec): Promise<ChangedFile[]> {
    const base = LIST_BASE[spec.kind](spec)
    const [numstat, names] = await Promise.all([
      run(cwd, [...base, '--numstat', '-z', '--no-renames']),
      run(cwd, [...base, '--name-status', '-z', '--no-renames'])
    ])
    return joinChangedFiles(parseNumstat(numstat), parseNameStatus(names))
  }

  // Scoped to the one path, so a checkout carrying a large untracked tree does not make
  // every patch request walk it.
  async function isUntracked(cwd: string, spec: ResolvedDiffSpec, path: string): Promise<boolean> {
    return spec.kind === 'worktree' && (await untracked(cwd, path)).length > 0
  }

  return {
    trackedFiles: tracked,

    async files(cwd, spec) {
      const changed = await tracked(cwd, spec)
      if (spec.kind !== 'worktree') return changed
      const extra = await Promise.all((await untracked(cwd)).map((path) => untrackedStat(cwd, path)))
      return [...changed, ...extra].sort((a, b) => a.path.localeCompare(b.path))
    },

    async patch(cwd, spec, path) {
      // Both questions at once: git has to be asked whether the path is untracked, and the
      // tracked diff is what the answer usually turns out to be. Serializing them made every
      // file in a review wait out two git processes back to back.
      const [trackedPatch, isNew] = await Promise.all([
        run(cwd, [...PATCH_BASE[spec.kind](spec), ...PATCH_FLAGS, '--', path], { okCodes: [0, 1] }),
        isUntracked(cwd, spec, path)
      ])
      if (!isNew) return toFilePatch(path, trackedPatch)
      return toFilePatch(path, await run(cwd, [...NO_INDEX, '--', '/dev/null', path], { okCodes: [0, 1] }))
    }
  }
}
