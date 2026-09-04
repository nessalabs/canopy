/**
 * Diffs for one `ResolvedDiffSpec`. The working-tree and commit cases differ only in
 * the base git arguments (tables below); listing, numstat joining, untracked handling
 * and patch capping are shared.
 */
import type { ChangedFile, FileContents, FilePatch } from '@canopy/shared'

import type { GitRunner } from './exec'
import { joinChangedFiles, parseNameStatus, parseNumstat } from './parse'

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
  patch(cwd: string, spec: ResolvedDiffSpec, path: string): Promise<FilePatch>
}

/** Same contract as `toFilePatch`, for whole files: text, or null when binary or over the cap. */
export function toFileContents(path: string, raw: string): FileContents {
  const size = Buffer.byteLength(raw)
  const binary = raw.slice(0, BINARY_SNIFF_BYTES).includes('\0')
  const truncated = size > FILE_CAP_BYTES
  return { path, content: binary || truncated ? null : raw, truncated, binary, size }
}

export function toFilePatch(path: string, raw: string): FilePatch {
  const binary = /^Binary files .* differ$/m.test(raw)
  const truncated = Buffer.byteLength(raw) > PATCH_CAP_BYTES
  return { path, patch: binary || truncated ? null : raw, truncated, binary }
}

export function createDiffReader(run: GitRunner, untracked: (cwd: string) => Promise<string[]>): DiffReader {
  async function tracked(cwd: string, spec: ResolvedDiffSpec): Promise<ChangedFile[]> {
    const base = LIST_BASE[spec.kind](spec)
    const [numstat, names] = await Promise.all([
      run(cwd, [...base, '--numstat', '-z', '--no-renames']),
      run(cwd, [...base, '--name-status', '-z', '--no-renames'])
    ])
    return joinChangedFiles(parseNumstat(numstat), parseNameStatus(names))
  }

  async function untrackedFile(cwd: string, path: string): Promise<ChangedFile> {
    // `--no-index` against /dev/null prints rename-style numstat; only the counts matter here.
    const out = await run(cwd, [...NO_INDEX, '--numstat', '--', '/dev/null', path], { okCodes: [0, 1] })
    const [add = '0', del = '0'] = out.split('\t')
    const binary = add === '-'
    return { path, status: 'U', additions: binary ? 0 : Number(add), deletions: binary ? 0 : Number(del), binary }
  }

  async function isUntracked(cwd: string, spec: ResolvedDiffSpec, path: string): Promise<boolean> {
    return spec.kind === 'worktree' && (await untracked(cwd)).includes(path)
  }

  return {
    async files(cwd, spec) {
      const changed = await tracked(cwd, spec)
      if (spec.kind !== 'worktree') return changed
      const extra = await Promise.all((await untracked(cwd)).map((path) => untrackedFile(cwd, path)))
      return [...changed, ...extra].sort((a, b) => a.path.localeCompare(b.path))
    },

    async patch(cwd, spec, path) {
      const args = (await isUntracked(cwd, spec, path))
        ? [...NO_INDEX, '--', '/dev/null', path]
        : [...PATCH_BASE[spec.kind](spec), ...PATCH_FLAGS, '--', path]
      const raw = await run(cwd, args, { okCodes: [0, 1] })
      return toFilePatch(path, raw)
    }
  }
}
