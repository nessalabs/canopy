import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createWorktrunk } from '../../src/env/worktrunk/wt'
import { runGit } from '../../src/git/exec'
import { createFixtureRepo, type FixtureRepo } from '../helpers/fixture-repo'

/** `wt` is optional; the wt-backed test only runs where it is installed. */
const hasWt = (process.env['PATH'] ?? '').split(delimiter).some((dir) => dir.length > 0 && existsSync(join(dir, 'wt')))

describe('worktrunk backend', () => {
  let repo: FixtureRepo
  let root: string
  beforeEach(async () => {
    repo = await createFixtureRepo()
    await repo.commit({ 'a.txt': 'one\n' }, 'init')
    root = realpathSync(mkdtempSync(join(tmpdir(), 'canopy-wt-')))
  })
  afterEach(() => {
    repo.cleanup()
    rmSync(root, { recursive: true, force: true })
  })

  it('creates and removes through plain git when wt is not wanted', async () => {
    const wt = createWorktrunk(runGit)
    const path = join(root, 'feat-x')
    const created = await wt.create({ repoPath: repo.path, path, branch: { mode: 'new', name: 'feat/x', base: 'main' }, useWt: false })
    expect(created).toEqual({ path, backend: 'git', createdBranch: true })
    expect(existsSync(join(path, 'a.txt'))).toBe(true)

    const removed = await wt.remove({ repoPath: repo.path, path, branch: 'feat/x', force: false, deleteBranch: 'always', useWt: false })
    expect(removed).toEqual({ backend: 'git', branchDeleted: true })
    expect(existsSync(path)).toBe(false)
    expect(await repo.git('branch', '--list', 'feat/x')).toBe('')
  })

  it('reuses an existing branch and keeps it when deleteBranch is never', async () => {
    await repo.branch('existing')
    const wt = createWorktrunk(runGit)
    const path = join(root, 'existing')
    const created = await wt.create({ repoPath: repo.path, path, branch: { mode: 'existing', name: 'existing' }, useWt: false })
    expect(created.createdBranch).toBe(false)

    const removed = await wt.remove({ repoPath: repo.path, path, branch: 'existing', force: false, deleteBranch: 'never', useWt: false })
    expect(removed.branchDeleted).toBe(false)
    expect(await repo.git('branch', '--list', 'existing')).toContain('existing')
  })

  it('refuses to remove a dirty worktree without force, and obeys force', async () => {
    const wt = createWorktrunk(runGit)
    const path = join(root, 'dirty')
    await wt.create({ repoPath: repo.path, path, branch: { mode: 'new', name: 'dirty', base: 'main' }, useWt: false })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(path, 'a.txt'), 'changed\n')

    await expect(wt.remove({ repoPath: repo.path, path, branch: 'dirty', force: false, deleteBranch: 'never', useWt: false })).rejects.toMatchObject({
      code: 'worktree_dirty'
    })
    await wt.remove({ repoPath: repo.path, path, branch: 'dirty', force: true, deleteBranch: 'never', useWt: false })
    expect(existsSync(path)).toBe(false)
  })

  it('reports the tool it found', async () => {
    const missing = createWorktrunk(runGit, { bin: 'definitely-not-wt-canopy' })
    expect(await missing.info()).toEqual({ available: false, version: null, path: null })

    const real = createWorktrunk(runGit)
    const info = await real.info()
    expect(info.available).toBe(hasWt)
    if (hasWt) expect(info.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it.skipIf(!hasWt)('drives wt switch and wt remove when it is installed', async () => {
    const wt = createWorktrunk(runGit)
    const path = join(root, 'wt-feature')
    const lines: string[] = []
    const created = await wt.create({
      repoPath: repo.path,
      path,
      branch: { mode: 'new', name: 'wt-feature', base: 'main' },
      useWt: true,
      onLine: (_stream, text) => lines.push(text)
    })
    expect(created.backend).toBe('wt')
    expect(created.createdBranch).toBe(true)
    expect(realpathSync(created.path)).toBe(realpathSync(path))
    expect(existsSync(join(path, 'a.txt'))).toBe(true)

    const removed = await wt.remove({ repoPath: repo.path, path, branch: 'wt-feature', force: false, deleteBranch: 'always', useWt: true })
    expect(removed.backend).toBe('wt')
    expect(removed.branchDeleted).toBe(true)
    expect(existsSync(path)).toBe(false)
  })
})
