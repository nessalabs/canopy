/**
 * "Is this worktree's HEAD already in its base branch?" — the fact that says a worktree is
 * safe to throw away. Ancestry alone misses the way most branches land today (a squash or a
 * rebase-merge leaves the original commits unreachable from base), so three questions are
 * asked in turn, cheapest first, against the local base and its `origin/` counterpart:
 *
 *   1. is HEAD an ancestor of a base tip?                      (`for-each-ref --contains`)
 *   2. does every commit on the branch have a patch there?      (`cherry`, rebase-merge)
 *   3. does the branch squashed into one patch exist there?     (`commit-tree` + `cherry`)
 *
 * 2 and 3 cost a patch-id for every base commit since the merge base, so the answer is cached
 * per (HEAD, base tips): a worktree nobody commits to and a base nobody moves is one cheap
 * `for-each-ref` per listing. The probe commit of step 3 is dangling and gc collects it.
 */
import type { Repo } from '../git/repo'

/** Beyond this many base commits since the branch left it, a patch-id walk stops being cheap. */
const MAX_BEHIND_FOR_PATCH_CHECK = 1000
/** Keyed by shas, so entries die of irrelevance rather than age; a bound keeps it a cache. */
const MAX_ENTRIES = 500

type MergedRepo = Pick<Repo, 'refTips' | 'refsContaining' | 'cherryApplied' | 'commitTree' | 'mergeBase'>

export interface MergedQuery {
  cwd: string
  head: string
  base: string
  /** Commits on HEAD that the local base lacks, from the status pass; 0 answers without git. */
  ahead: number | null
  behind: number | null
}

export class MergedDetector {
  private readonly cache = new Map<string, boolean>()

  constructor(private readonly repo: MergedRepo) {}

  /**
   * Null means there is nothing to say: HEAD *is* the base tip (a branch that never left it,
   * or a fast-forward the base has not moved past yet), no base ref, or too far behind to
   * check patches.
   */
  async isMerged({ cwd, head, base, ahead, behind }: MergedQuery): Promise<boolean | null> {
    if (ahead === 0) return behind === 0 ? null : true
    const tips = await this.repo.refTips(cwd, [`refs/heads/${base}`, `refs/remotes/origin/${base}`])
    if (tips.length === 0) return null
    const key = `${head}|${tips.map((tip) => tip.sha).join('|')}`
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached

    const result = await this.detect(cwd, head, tips, behind)
    if (result !== null) this.remember(key, result)
    return result
  }

  private async detect(cwd: string, head: string, tips: { ref: string; sha: string }[], behind: number | null): Promise<boolean | null> {
    if ((await this.repo.refsContaining(cwd, head, tips.map((tip) => tip.ref))).length > 0) return true
    if (behind !== null && behind > MAX_BEHIND_FOR_PATCH_CHECK) return null
    // Distinct tips only: the local base and origin usually point at the same commit.
    for (const sha of new Set(tips.map((tip) => tip.sha))) {
      if (await this.repo.cherryApplied(cwd, sha, head)) return true
      const mergeBase = await this.repo.mergeBase(cwd, sha)
      if (mergeBase === null || mergeBase === head) continue
      const probe = await this.repo.commitTree(cwd, `${head}^{tree}`, mergeBase, 'canopy merged probe')
      if (await this.repo.cherryApplied(cwd, sha, probe)) return true
    }
    return false
  }

  private remember(key: string, merged: boolean): void {
    if (this.cache.size >= MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    this.cache.set(key, merged)
  }
}
