/**
 * Worktree snapshots as git trees. A snapshot is `git add -A` into a throwaway index plus
 * `write-tree`: the exact working state (untracked included, ignored excluded) as one sha,
 * costing nothing when nothing changed. A ref keeps each tree safe from gc.
 */
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { GitRunner } from '../../git/exec'
import { newId } from '../../lib/ids'

export const SNAPSHOT_REF = (tree: string): string => `refs/canopy/snapshots/${tree}`

/** How one path differs between two trees, going from the first to the second. */
export interface TreeChange {
  /** `A` — the path is new in `after`; `D` — it is gone from it; anything else — its content changed. */
  status: string
  path: string
}

export interface Snapshots {
  /** The tree sha of the worktree's current state; also pinned under `refs/canopy/snapshots/`. */
  take(cwd: string): Promise<string>
  /** Paths that differ between two trees. */
  changedPaths(cwd: string, before: string, after: string): Promise<string[]>
  /**
   * Whether `sha` is a tree `take` pinned under `refs/canopy/snapshots/`. Being a tree is not
   * enough: every commit's tree is one, and restoring the checkout to `HEAD^{tree}` on request
   * would be a checkout nobody asked for, not a rewind.
   */
  isSnapshot(cwd: string, sha: string): Promise<boolean>
  /** The same paths `changedPaths` reports, each with how it differs. */
  changes(cwd: string, before: string, after: string): Promise<TreeChange[]>
  /** Lines added and removed going from one tree to the other; a binary file counts as neither. */
  countLines(cwd: string, before: string, after: string): Promise<{ insertions: number; deletions: number }>
  /**
   * Puts `paths` back to their content in `tree`, recreating any the worktree no longer has.
   *
   * `git restore --worktree`, never `git checkout <tree> -- <path>`: checkout writes the index as
   * well, and Canopy's commit panel treats the index as the user's own staging. Undoing an agent's
   * edits must not quietly stage them.
   */
  restorePaths(cwd: string, tree: string, paths: string[]): Promise<void>
  /**
   * Deletes `paths` from the worktree — the files that did not exist in the tree being restored.
   *
   * The index entry goes with them: leaving one behind would stage a file that is no longer there,
   * and the commit panel would show a phantom addition nobody made.
   */
  removePaths(cwd: string, paths: string[]): Promise<void>
}

export function createSnapshots(run: GitRunner): Snapshots {
  /**
   * Pathspecs on stdin, so a rewind of a thousand files is one call rather than a guess at how
   * long an argument list this OS will take. NUL-separated, so no path needs quoting.
   */
  const withPaths = (cwd: string, args: string[], paths: string[]): Promise<string> =>
    run(cwd, [...args, '--pathspec-from-file=-', '--pathspec-file-nul'], { input: `${paths.join('\0')}\0` })

  return {
    async take(cwd) {
      const index = join(tmpdir(), `canopy-index-${newId()}`)
      const env = { GIT_INDEX_FILE: index }
      try {
        await run(cwd, ['add', '-A', '--', '.'], { env })
        const tree = (await run(cwd, ['write-tree'], { env })).trim()
        await run(cwd, ['update-ref', SNAPSHOT_REF(tree), tree])
        return tree
      } finally {
        await rm(index, { force: true })
      }
    },
    async changedPaths(cwd, before, after) {
      if (before === after) return []
      const out = await run(cwd, ['diff-tree', '-r', '--name-only', '-z', '--no-renames', before, after])
      return out.split('\0').filter(Boolean)
    },
    async isSnapshot(cwd, sha) {
      // The ref is named after the tree it pins, so the answer is that it resolves to that tree.
      // `--verify --quiet` exits 1 for a ref that is not there, which is the other answer.
      const pinned = await run(cwd, ['rev-parse', '--verify', '--quiet', SNAPSHOT_REF(sha)], { okCodes: [0, 1] }).catch(() => '')
      return pinned.trim() === sha
    },
    async changes(cwd, before, after) {
      if (before === after) return []
      // `-z --name-status` writes status and path as separate NUL-terminated fields, so a path
      // with a newline or a quote in it survives the round trip intact.
      const out = await run(cwd, ['diff-tree', '-r', '--name-status', '-z', '--no-renames', before, after])
      const fields = out.split('\0').filter(Boolean)
      const changes: TreeChange[] = []
      for (let index = 0; index + 1 < fields.length; index += 2) changes.push({ status: fields[index] as string, path: fields[index + 1] as string })
      return changes
    },
    async countLines(cwd, before, after) {
      if (before === after) return { insertions: 0, deletions: 0 }
      const out = await run(cwd, ['diff-tree', '-r', '--numstat', '--no-renames', before, after])
      let insertions = 0
      let deletions = 0
      for (const line of out.split('\n')) {
        // A binary file reports `-` for both counts; there are no lines to count in one.
        const [added, removed] = line.split('\t')
        insertions += Number.parseInt(added ?? '', 10) || 0
        deletions += Number.parseInt(removed ?? '', 10) || 0
      }
      return { insertions, deletions }
    },
    async restorePaths(cwd, tree, paths) {
      if (paths.length === 0) return
      await withPaths(cwd, ['restore', '--source', tree, '--worktree'], paths)
    },
    async removePaths(cwd, paths) {
      if (paths.length === 0) return
      await Promise.all(paths.map((path) => rm(join(cwd, path), { force: true })))
      // `--ignore-unmatch` because most of these were never staged; the ones that were must not
      // be left behind as a staged add of a file that no longer exists.
      await withPaths(cwd, ['rm', '--cached', '-q', '--ignore-unmatch'], paths)
    }
  }
}
