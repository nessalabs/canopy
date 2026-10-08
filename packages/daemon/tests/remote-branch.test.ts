import { execa } from 'execa'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runGit } from '../src/git/exec'
import { fetchRemote, listRemoteBranches, prepareRemoteBranch } from '../src/git/remote-branch'
import { createFixtureRepo, type FixtureRepo } from './helpers/fixture-repo'

/** `upstream` pushes to a bare origin; `local` is a clone of it, the repo Canopy manages. */
describe('remote branches', () => {
  let upstream: FixtureRepo
  let dir: string
  let origin: string
  let local: string
  const git = (cwd: string, ...args: string[]) => execa('git', args, { cwd }).then((r) => r.stdout)
  const tip = (cwd: string, ref: string) => git(cwd, 'rev-parse', ref)
  const lines: string[] = []
  const log = (line: string) => lines.push(line)

  beforeEach(async () => {
    upstream = await createFixtureRepo()
    await upstream.commit({ 'a.txt': '1' }, 'init')
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'canopy-remote-')))
    origin = join(dir, 'origin.git')
    local = join(dir, 'local')
    await git(dir, 'init', '-q', '--bare', origin)
    await upstream.git('remote', 'add', 'origin', origin)
    await upstream.git('push', '-q', 'origin', 'main')
    await git(dir, 'clone', '-q', origin, local)
    await git(local, 'config', 'user.name', 'Local')
    await git(local, 'config', 'user.email', 'local@example.com')
    await git(local, 'config', 'commit.gpgsign', 'false')
    lines.length = 0
  })
  afterEach(() => {
    upstream.cleanup()
    rmSync(dir, { recursive: true, force: true })
  })

  const pushBranch = async (name: string, file: string) => {
    await upstream.git('checkout', '-q', '-B', name)
    await upstream.commit({ [file]: name }, `work on ${name}`)
    await upstream.git('push', '-q', '-f', 'origin', name)
    await upstream.git('checkout', '-q', 'main')
  }

  it('lists the remote branches after a fetch, without HEAD, marking local ones', async () => {
    await pushBranch('feat/pushed', 'b.txt')
    expect((await listRemoteBranches(runGit, local, 'origin')).map((b) => b.name)).not.toContain('feat/pushed')
    await fetchRemote(runGit, local, 'origin')
    const branches = await listRemoteBranches(runGit, local, 'origin')
    expect(branches.map((b) => b.name).sort()).toEqual(['feat/pushed', 'main'])
    expect(branches.find((b) => b.name === 'main')?.hasLocal).toBe(true)
    expect(branches.find((b) => b.name === 'feat/pushed')?.hasLocal).toBe(false)
  })

  it('creates a tracking branch for a branch that is only on the remote, fetching it first', async () => {
    await pushBranch('feat/new', 'c.txt')
    const detail = await prepareRemoteBranch(runGit, local, { remote: 'origin', name: 'feat/new' }, log)
    expect(detail).toBe('new branch tracking origin/feat/new')
    expect(await tip(local, 'feat/new')).toBe(await upstream.git('rev-parse', 'feat/new'))
    expect(await git(local, 'rev-parse', '--abbrev-ref', 'feat/new@{upstream}')).toBe('origin/feat/new')
  })

  it('fast-forwards a local branch that is behind, and keeps one that is ahead', async () => {
    await pushBranch('feat/x', 'd.txt')
    await prepareRemoteBranch(runGit, local, { remote: 'origin', name: 'feat/x' }, log)
    await upstream.git('checkout', '-q', 'feat/x')
    await upstream.commit({ 'd.txt': 'more' }, 'more')
    await upstream.git('push', '-q', 'origin', 'feat/x')
    expect(await prepareRemoteBranch(runGit, local, { remote: 'origin', name: 'feat/x' }, log)).toBe('feat/x fast-forwarded to origin')
    expect(await tip(local, 'feat/x')).toBe(await upstream.git('rev-parse', 'feat/x'))

    await git(local, 'checkout', '-q', 'feat/x')
    await git(local, 'commit', '-q', '--allow-empty', '-m', 'local only')
    const mine = await tip(local, 'feat/x')
    await git(local, 'checkout', '-q', 'main')
    expect(await prepareRemoteBranch(runGit, local, { remote: 'origin', name: 'feat/x' }, log)).toContain('ahead')
    expect(await tip(local, 'feat/x')).toBe(mine)
  })

  it('refuses a diverged local branch and leaves it alone', async () => {
    await pushBranch('feat/y', 'e.txt')
    await prepareRemoteBranch(runGit, local, { remote: 'origin', name: 'feat/y' }, log)
    await git(local, 'checkout', '-q', 'feat/y')
    await git(local, 'commit', '-q', '--allow-empty', '-m', 'local only')
    const mine = await tip(local, 'feat/y')
    await git(local, 'checkout', '-q', 'main')
    await pushBranch('feat/y', 'f.txt') // force-pushed from main: shares nothing new with local
    await expect(prepareRemoteBranch(runGit, local, { remote: 'origin', name: 'feat/y' }, log)).rejects.toMatchObject({ code: 'branch_diverged' })
    expect(await tip(local, 'feat/y')).toBe(mine)
  })

  it('reports a branch the remote does not have, and rejects option-like names', async () => {
    await expect(prepareRemoteBranch(runGit, local, { remote: 'origin', name: 'nope' }, log)).rejects.toMatchObject({ code: 'remote_branch_missing' })
    await expect(prepareRemoteBranch(runGit, local, { remote: 'origin', name: '--upload-pack=x' }, log)).rejects.toMatchObject({ code: 'invalid_branch' })
    await expect(prepareRemoteBranch(runGit, local, { remote: '-x', name: 'main' }, log)).rejects.toMatchObject({ code: 'invalid_remote' })
  })
})
