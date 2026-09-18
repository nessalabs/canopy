import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createWorktreeBackend } from '../../src/env/worktree/backend'
import { runGit } from '../../src/git/exec'
import { createFixtureRepo, type FixtureRepo } from '../helpers/fixture-repo'

/** `canopyd` is optional; the tool-backed tests only run where it is installed. */
const hasTool = (process.env['PATH'] ?? '').split(delimiter).some((dir) => dir.length > 0 && existsSync(join(dir, 'canopyd')))

describe('worktree backend', () => {
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

  it('creates and removes through plain git when the tool is not wanted', async () => {
    const wt = createWorktreeBackend(runGit)
    const path = join(root, 'feat-x')
    const created = await wt.create({ repoPath: repo.path, path, branch: { mode: 'new', name: 'feat/x', base: 'main' }, useTool: false })
    expect(created).toEqual({ path, backend: 'git', createdBranch: true })
    expect(existsSync(join(path, 'a.txt'))).toBe(true)

    const removed = await wt.remove({ repoPath: repo.path, path, branch: 'feat/x', force: false, deleteBranch: 'always', useTool: false })
    expect(removed).toEqual({ backend: 'git', branchDeleted: true })
    expect(existsSync(path)).toBe(false)
    expect(await repo.git('branch', '--list', 'feat/x')).toBe('')
  })

  it('reuses an existing branch and keeps it when deleteBranch is never', async () => {
    await repo.branch('existing')
    const wt = createWorktreeBackend(runGit)
    const path = join(root, 'existing')
    const created = await wt.create({ repoPath: repo.path, path, branch: { mode: 'existing', name: 'existing' }, useTool: false })
    expect(created.createdBranch).toBe(false)

    const removed = await wt.remove({ repoPath: repo.path, path, branch: 'existing', force: false, deleteBranch: 'never', useTool: false })
    expect(removed.branchDeleted).toBe(false)
    expect(await repo.git('branch', '--list', 'existing')).toContain('existing')
  })

  it('refuses to remove a dirty worktree without force, and obeys force', async () => {
    const wt = createWorktreeBackend(runGit)
    const path = join(root, 'dirty')
    await wt.create({ repoPath: repo.path, path, branch: { mode: 'new', name: 'dirty', base: 'main' }, useTool: false })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(path, 'a.txt'), 'changed\n')

    await expect(wt.remove({ repoPath: repo.path, path, branch: 'dirty', force: false, deleteBranch: 'never', useTool: false })).rejects.toMatchObject({
      code: 'worktree_dirty'
    })
    await wt.remove({ repoPath: repo.path, path, branch: 'dirty', force: true, deleteBranch: 'never', useTool: false })
    expect(existsSync(path)).toBe(false)
  })

  it('reports the tool it found', async () => {
    const missing = createWorktreeBackend(runGit, { bin: 'definitely-not-wt-canopy' })
    expect(await missing.info()).toEqual({ available: false, version: null, path: null })

    const real = createWorktreeBackend(runGit)
    const info = await real.info()
    expect(info.available).toBe(hasTool)
    if (hasTool) expect(info.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it.skipIf(!hasTool)('drives canopyd new and canopyd rm when it is installed', async () => {
    const wt = createWorktreeBackend(runGit)
    const path = join(root, 'wt-feature')
    const lines: string[] = []
    const created = await wt.create({
      repoPath: repo.path,
      path,
      branch: { mode: 'new', name: 'wt-feature', base: 'main' },
      useTool: true,
      onLine: (_stream, text) => lines.push(text)
    })
    expect(created.backend).toBe('canopyd')
    expect(created.createdBranch).toBe(true)
    expect(realpathSync(created.path)).toBe(realpathSync(path))
    expect(existsSync(join(path, 'a.txt'))).toBe(true)

    const removed = await wt.remove({ repoPath: repo.path, path, branch: 'wt-feature', force: false, deleteBranch: 'always', useTool: true })
    expect(removed.backend).toBe('canopyd')
    expect(removed.branchDeleted).toBe(true)
    expect(existsSync(path)).toBe(false)
  })
})
