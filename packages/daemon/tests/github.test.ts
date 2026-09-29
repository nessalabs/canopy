import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runGit } from '../src/git/exec'
import type { GhRun, GhRunner } from '../src/github/gh'
import { GitHubService, parseRemote, titleFromBranch, toPullRequest } from '../src/github/service'
import { createFixtureRepo, type FixtureRepo } from './helpers/fixture-repo'

const ok = (stdout = ''): GhRun => ({ found: true, exitCode: 0, stdout, stderr: '' })

/** A `gh` that answers from a table and records what it was asked. */
function fakeGh(answer: (args: string[]) => GhRun): GhRunner & { calls: string[][] } {
  const calls: string[][] = []
  const run = (async (_cwd: string, args: string[]) => {
    calls.push(args)
    return answer(args)
  }) as GhRunner & { calls: string[][] }
  run.calls = calls
  return run
}

const RAW_PR = {
  number: 7,
  title: 'Add the thing',
  body: 'Why it matters',
  url: 'https://github.com/acme/app/pull/7',
  state: 'OPEN',
  isDraft: false,
  author: { login: 'octo' },
  baseRefName: 'main',
  headRefName: 'feat/thing',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-02T00:00:00Z',
  mergedAt: null,
  closedAt: '0001-01-01T00:00:00Z',
  additions: 10,
  deletions: 2,
  changedFiles: 3,
  commits: [{}, {}],
  reviewDecision: '',
  mergeable: 'MERGEABLE',
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'test', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://ci/1' },
    { __typename: 'CheckRun', name: 'lint', workflowName: 'CI', status: 'IN_PROGRESS', conclusion: '', detailsUrl: '' },
    { __typename: 'CheckRun', name: 'e2e', status: 'COMPLETED', conclusion: 'TIMED_OUT' },
    { __typename: 'StatusContext', context: 'deploy', state: 'ERROR', targetUrl: 'https://deploy' }
  ],
  reviews: [
    { author: { login: 'rev' }, body: '', state: 'COMMENTED', submittedAt: '2026-09-01T02:00:00Z' },
    { author: { login: 'rev' }, body: '', state: 'APPROVED', submittedAt: '2026-09-01T03:00:00Z' }
  ],
  comments: [
    { author: { login: 'bot' }, body: 'hidden', createdAt: '2026-09-01T00:30:00Z', isMinimized: true },
    { author: { login: 'pal' }, body: 'nice', createdAt: '2026-09-01T01:00:00Z', isMinimized: false }
  ]
}

describe('github helpers', () => {
  it('reads host and repo from every remote URL shape', () => {
    expect(parseRemote('git@github.com:acme/app.git')).toEqual({ host: 'github.com', repo: 'acme/app' })
    expect(parseRemote('https://github.com/acme/app')).toEqual({ host: 'github.com', repo: 'acme/app' })
    expect(parseRemote('ssh://git@ghe.corp.io:22/team/svc.git')).toEqual({ host: 'ghe.corp.io', repo: 'team/svc' })
    expect(parseRemote('https://gitlab.com/group/sub/proj.git')).toEqual({ host: 'gitlab.com', repo: 'sub/proj' })
    expect(parseRemote('/srv/git/app.git')).toBeNull()
  })

  it('titles a branch as words', () => {
    expect(titleFromBranch('feat/add-pr_tab')).toBe('Add pr tab')
  })

  it('normalizes checks, drops empty review wrappers and hidden comments, and orders the timeline', () => {
    const pr = toPullRequest(RAW_PR as never)
    expect(pr.closedAt).toBeNull()
    expect(pr.reviewDecision).toBeNull()
    expect(pr.commits).toBe(2)
    expect(pr.checks.map((check) => [check.name, check.outcome, check.workflow])).toEqual([
      ['test', 'pass', 'CI'],
      ['lint', 'pending', 'CI'],
      ['e2e', 'fail', null],
      ['deploy', 'fail', null]
    ])
    expect(pr.events.map((event) => [event.kind, event.author, event.verdict])).toEqual([
      ['comment', 'pal', null],
      ['review', 'rev', 'APPROVED']
    ])
  })
})

describe('GitHubService', () => {
  let repo: FixtureRepo
  let bare: string

  beforeEach(async () => {
    repo = await createFixtureRepo()
    await repo.commit({ 'a.txt': 'one\n' }, 'init')
    bare = realpathSync(mkdtempSync(join(tmpdir(), 'canopy-remote-')))
    await execa('git', ['init', '-q', '--bare', '-b', 'main', bare])
    await repo.git('remote', 'add', 'origin', bare)
    await repo.git('push', '-q', 'origin', 'main')
    await repo.git('checkout', '-q', '-b', 'feat/thing')
  })
  afterEach(() => {
    repo.cleanup()
    rmSync(bare, { recursive: true, force: true })
  })

  const service = (gh: GhRunner, remoteUrl = 'git@github.com:acme/app.git') => {
    // The fixture pushes to a local bare repo; the URL gh and the pane see is a GitHub one.
    return {
      ready: repo.git('remote', 'set-url', 'origin', remoteUrl).then(() => repo.git('remote', 'set-url', '--push', 'origin', bare)),
      github: new GitHubService({ git: runGit, gh, worktrees: { location: () => ({ path: repo.path, baseBranch: 'main', projectId: 'p' }) } })
    }
  }

  it('says gh is missing without asking anything else', async () => {
    const gh = fakeGh(() => ({ found: false, exitCode: -1, stdout: '', stderr: '' }))
    const { ready, github } = service(gh)
    await ready
    const res = await github.read('w')
    expect(res.gh).toMatchObject({ state: 'missing', host: 'github.com', repo: 'acme/app' })
    expect(res.pr).toBeNull()
    expect(gh.calls).toEqual([['--version']])
  })

  it('tells a signed-out GitHub host from a host that is not GitHub', async () => {
    const gh = fakeGh((args) => (args[0] === 'auth' ? { found: true, exitCode: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts.\n' } : ok()))
    const signedOut = service(gh)
    await signedOut.ready
    expect((await signedOut.github.read('w')).gh).toMatchObject({ state: 'unauthenticated', detail: 'You are not logged into any GitHub hosts.' })

    const elsewhere = service(gh, 'https://gitlab.com/acme/app.git')
    await elsewhere.ready
    expect((await elsewhere.github.read('w')).gh).toMatchObject({ state: 'not-github', host: 'gitlab.com' })
  })

  it('reports no remote', async () => {
    await repo.git('remote', 'remove', 'origin')
    const github = new GitHubService({ git: runGit, gh: fakeGh(() => ok()), worktrees: { location: () => ({ path: repo.path, baseBranch: 'main', projectId: 'p' }) } })
    expect((await github.read('w')).gh.state).toBe('no-remote')
  })

  it('suggests a PR from the branch commits when there is none, and remembers a working login', async () => {
    await repo.commit({ 'b.txt': 'two\n' }, 'Add b\n\nBecause b.')
    const gh = fakeGh((args) => (args[0] === 'pr' ? ok('[]') : ok()))
    const { ready, github } = service(gh)
    await ready
    const first = await github.read('w')
    expect(first).toMatchObject({ branch: 'feat/thing', pr: null, draft: { title: 'Add b', body: 'Because b.' }, upstream: { name: null } })

    await repo.commit({ 'c.txt': 'three\n' }, 'Add c')
    const second = await github.read('w')
    expect(second.draft).toEqual({ title: 'Thing', body: '- Add b\n- Add c' })
    expect(gh.calls.filter((args) => args[0] === 'auth')).toHaveLength(1)
  })

  it('does not treat a tracked base branch as the upstream', async () => {
    await repo.git('branch', '--set-upstream-to=origin/main')
    const { ready, github } = service(fakeGh((args) => (args[0] === 'pr' ? ok('[]') : ok())))
    await ready
    expect((await github.read('w')).upstream).toEqual({ name: null, ahead: null, behind: null })
  })

  it('pushes the branch before opening the PR, then reads it back', async () => {
    await repo.commit({ 'b.txt': 'two\n' }, 'Add b')
    let created = false
    const gh = fakeGh((args) => {
      if (args[0] === 'pr' && args[1] === 'create') {
        created = true
        return ok('https://github.com/acme/app/pull/7\n')
      }
      if (args[0] === 'pr') return ok(created ? JSON.stringify([RAW_PR]) : '[]')
      return ok()
    })
    const { ready, github } = service(gh)
    await ready
    const pr = await github.create('w', { title: 'Add the thing', body: 'Why', draft: true })
    expect(pr.number).toBe(7)
    expect(gh.calls.find((args) => args[1] === 'create')).toEqual(['pr', 'create', '--head', 'feat/thing', '--base', 'main', '--title', 'Add the thing', '--body', 'Why', '--draft'])
    const remoteTip = (await execa('git', ['rev-parse', 'refs/heads/feat/thing'], { cwd: bare })).stdout
    expect(remoteTip).toBe(await repo.git('rev-parse', 'HEAD'))
    expect(await github.upstream(repo.path, 'feat/thing')).toEqual({ name: 'origin/feat/thing', ahead: 0, behind: 0 })

    await repo.commit({ 'c.txt': 'three\n' }, 'Add c')
    expect((await github.upstream(repo.path, 'feat/thing')).ahead).toBe(1)
    expect((await github.push('w')).upstream).toEqual({ name: 'origin/feat/thing', ahead: 0, behind: 0 })
  })

  it('passes gh failures through with what gh said', async () => {
    const gh = fakeGh((args) => (args[0] === 'pr' ? { found: true, exitCode: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway\n' } : ok()))
    const { ready, github } = service(gh)
    await ready
    await expect(github.read('w')).rejects.toMatchObject({ status: 502, code: 'gh_failed', message: 'HTTP 502: Bad Gateway' })
  })
})
