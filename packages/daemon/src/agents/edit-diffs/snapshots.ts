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

export interface Snapshots {
  /** The tree sha of the worktree's current state; also pinned under `refs/canopy/snapshots/`. */
  take(cwd: string): Promise<string>
  /** Paths that differ between two trees. */
  changedPaths(cwd: string, before: string, after: string): Promise<string[]>
}

export function createSnapshots(run: GitRunner): Snapshots {
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
    }
  }
}
