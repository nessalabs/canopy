import { describe, expect, it } from 'vitest'

import type { Worktree, WorktreeStatus } from '@canopy/shared'

import { mergeAffordance, mergedLabel } from '../src/lib/status'

const status = (over: Partial<WorktreeStatus> = {}): WorktreeStatus => ({
  head: 'main',
  ahead: 0,
  behind: 0,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicted: 0,
  dirtyTotal: 0,
  lastCommit: null,
  merged: null,
  ...over
})

/** Only the fields the two functions read; a whole Worktree would bury what each case is about. */
const wt = (over: Partial<Worktree> = {}): Pick<Worktree, 'isMain' | 'branch' | 'baseBranch' | 'status'> => ({
  isMain: false,
  branch: 'feat/x',
  baseBranch: 'main',
  status: status(),
  ...over
})

describe('mergedLabel', () => {
  it('says nothing for the main checkout or a daemon that could not tell', () => {
    expect(mergedLabel(wt({ isMain: true, status: status({ merged: true }) }))).toBeNull()
    expect(mergedLabel(wt({ status: status({ merged: null }) }))).toBeNull()
    expect(mergedLabel(wt({ status: null }))).toBeNull()
  })

  it('counts an unmerged branch as never disposable', () => {
    expect(mergedLabel(wt({ status: status({ merged: false, ahead: 2 }) }))).toEqual({ merged: false, disposable: false, label: 'Not merged into main (2 commits ahead)' })
    expect(mergedLabel(wt({ status: status({ merged: false, ahead: 1 }) }))?.label).toBe('Not merged into main (1 commit ahead)')
  })

  it('calls a landed branch with a clean checkout disposable', () => {
    expect(mergedLabel(wt({ status: status({ merged: true, ahead: 3, behind: 1 }) }))).toEqual({ merged: true, disposable: true, label: 'Merged into main' })
  })

  it('does not call a branch with no commits of its own "merged"', () => {
    // Ahead 0 and behind: the base moved on and this branch never landed anything, which is
    // safe to remove but is not the same sentence as work that landed.
    expect(mergedLabel(wt({ status: status({ merged: true, ahead: 0, behind: 4 }) }))).toEqual({ merged: true, disposable: true, label: 'Nothing of its own to land on main' })
  })

  it('withholds disposable while uncommitted work sits in the checkout', () => {
    // The merge carried the commits; it carried none of this, so the worktree still holds the
    // only copy. Merged stays true — it is a fact about the branch — but the tick has to go.
    const verdict = mergedLabel(wt({ status: status({ merged: true, ahead: 2, dirtyTotal: 11, unstaged: 11 }) }))
    expect(verdict).toEqual({ merged: true, disposable: false, label: 'Merged into main, but 11 uncommitted changes here would be lost' })
  })
})

describe('mergeAffordance', () => {
  it('offers nothing on the primary checkout or a detached HEAD', () => {
    expect(mergeAffordance(wt({ isMain: true })).shown).toBe(false)
    expect(mergeAffordance(wt({ branch: null })).shown).toBe(false)
  })

  it('refuses to state a git fact about a worktree it cannot read', () => {
    // The regression: a null status read as `ahead ?? 0` produced "No commits main lacks"
    // beside a diff pane that had just failed to open the checkout at all.
    const gone = mergeAffordance(wt({ status: null }))
    expect(gone).toMatchObject({ shown: true, enabled: false })
    expect(gone.hint).toBe('This worktree has no checkout on disk; nothing can be read from it')
  })

  it('says so when the base is not a branch here', () => {
    expect(mergeAffordance(wt({ status: status({ ahead: null, behind: null }) })).hint).toBe('main is not a branch in this repository')
  })

  it('reads as merged, as nothing to land, or as ready', () => {
    expect(mergeAffordance(wt({ status: status({ merged: true, ahead: 2 }) }))).toMatchObject({ enabled: false, label: 'Merged', hint: 'Already merged into main' })
    expect(mergeAffordance(wt({ status: status({ ahead: 0 }) }))).toMatchObject({ enabled: false, hint: 'No commits main lacks' })
    expect(mergeAffordance(wt({ status: status({ ahead: 1 }) }))).toMatchObject({ enabled: true, label: 'Merge into main', hint: 'Land 1 commit on main' })
    expect(mergeAffordance(wt({ status: status({ ahead: 4 }) })).hint).toBe('Land 4 commits on main')
  })
})
