import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ReviewComment } from '@canopy/shared'

import { runGit } from '../src/git/exec'
import type { GhRun, GhRunner } from '../src/github/gh'
import { GitHubService, parseRemote, titleFromBranch, toPullRequest } from '../src/github/service'
import { createFixtureRepo, type FixtureRepo } from './helpers/fixture-repo'

const ok = (stdout = ''): GhRun => ({ found: true, exitCode: 0, stdout, stderr: '' })

/** Local comments for a review, and a record of which were marked as posted. */
function fakeReview(comments: ReviewComment[] = []) {
  const posted: Array<{ ids: string[]; label: string }> = []
  return { posted, list: () => comments, markPosted: (_worktreeId: string, ids: string[], label: string) => void posted.push({ ids, label }) }
}

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
  commits: [
    { oid: 'a'.repeat(40), messageHeadline: 'First', authoredDate: '2026-09-01T00:00:00Z', authors: [{ name: 'Octo Cat', login: 'octo', email: 'o@x' }] },
    { oid: 'b'.repeat(40), messageHeadline: 'Second', committedDate: '2026-09-01T01:00:00Z', authors: [{ login: 'pal' }] }
  ],
  assignees: [{ login: 'octo', name: 'Octo Cat' }, { login: 'pal', name: '' }],
  reviewRequests: [{ __typename: 'User', login: 'rev' }, { __typename: 'Team', slug: 'core' }],
  latestReviews: [
    { author: { login: 'rev' }, state: 'CHANGES_REQUESTED' },
    { author: { login: 'boss' }, state: 'APPROVED' }
  ],
  labels: [{ name: 'bug', color: 'd73a4a' }],
  milestone: { title: 'v1' },
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
    expect(pr.commitLog.map((commit) => [commit.shortSha, commit.subject, commit.author])).toEqual([
      ['aaaaaaa', 'First', 'Octo Cat'],
      ['bbbbbbb', 'Second', 'pal']
    ])
    expect(pr.assignees).toEqual([
      { login: 'octo', name: 'Octo Cat' },
      { login: 'pal', name: null }
    ])
    // Re-requested reviewers show as requested; their old verdict is about older code.
    expect(pr.reviewers).toEqual([
      { name: 'boss', team: false, state: 'APPROVED' },
      { name: 'rev', team: false, state: 'requested' },
      { name: 'core', team: true, state: 'requested' }
    ])
    expect([pr.labels, pr.milestone]).toEqual([[{ name: 'bug', color: 'd73a4a' }], 'v1'])
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

  const service = (gh: GhRunner, remoteUrl = 'git@github.com:acme/app.git', review = fakeReview()) => {
    // The fixture pushes to a local bare repo; the URL gh and the pane see is a GitHub one.
    return {
      ready: repo.git('remote', 'set-url', 'origin', remoteUrl).then(() => repo.git('remote', 'set-url', '--push', 'origin', bare)),
      github: new GitHubService({ review, git: runGit, gh, worktrees: { location: () => ({ path: repo.path, baseBranch: 'main', projectId: 'p' }) } })
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
    const github = new GitHubService({ review: fakeReview(), git: runGit, gh: fakeGh(() => ok()), worktrees: { location: () => ({ path: repo.path, baseBranch: 'main', projectId: 'p' }) } })
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

  it('suggests nothing on the base branch itself', async () => {
    await repo.git('checkout', '-q', 'main')
    const { ready, github } = service(fakeGh((args) => (args[0] === 'pr' ? ok('[]') : ok())))
    await ready
    expect(await github.read('w')).toMatchObject({ branch: 'main', baseBranch: 'main', pr: null, draft: null })
  })

  it('offers the remote branches as targets and starts on the worktree base when GitHub has it', async () => {
    await repo.git('push', '-q', 'origin', 'main:refs/heads/develop', 'main:refs/heads/release')
    await repo.git('fetch', '-q', bare, '+refs/heads/*:refs/remotes/origin/*')
    await repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop')
    const gh = fakeGh((args) => (args[0] === 'pr' ? ok('[]') : ok()))
    const read = async (baseBranch: string) => {
      await repo.git('remote', 'set-url', 'origin', 'git@github.com:acme/app.git')
      await repo.git('remote', 'set-url', '--push', 'origin', bare)
      const github = new GitHubService({ review: fakeReview(), git: runGit, gh, worktrees: { location: () => ({ path: repo.path, baseBranch, projectId: 'p' }) } })
      return github.read('w')
    }
    expect(await read('release')).toMatchObject({ bases: ['develop', 'main', 'release'], suggestedBase: 'release' })
    // A base recorded at creation that GitHub never had falls back to the remote's default.
    expect((await read('develop-dev')).suggestedBase).toBe('develop')
  })

  it('reports PR commits this checkout lacks, and fetches them from refs/pull/N/head', async () => {
    // Someone else pushed a commit to the PR; it exists only on the remote.
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'canopy-other-')))
    await execa('git', ['clone', '-q', bare, other])
    await execa('git', ['-C', other, '-c', 'user.name=O', '-c', 'user.email=o@x', 'commit', '-q', '--allow-empty', '-m', 'from elsewhere'])
    const theirs = (await execa('git', ['-C', other, 'rev-parse', 'HEAD'])).stdout
    await execa('git', ['-C', other, 'push', '-q', 'origin', 'HEAD:refs/pull/7/head'])
    rmSync(other, { recursive: true, force: true })
    const ours = await repo.git('rev-parse', 'HEAD')
    const raw = { ...RAW_PR, commits: [{ oid: ours }, { oid: theirs }] }
    const { ready, github } = service(fakeGh((args) => (args[0] === 'pr' ? ok(JSON.stringify([raw])) : ok())))
    await ready

    expect((await github.read('w')).pr?.missingCommits).toEqual([theirs])
    // The pane's URL is GitHub's; the fetch itself goes to the fixture's bare remote.
    await repo.git('remote', 'set-url', 'origin', bare)
    expect(await github.fetchPr('w')).toEqual({ fetched: 1 })
    expect(await repo.git('cat-file', '-t', theirs)).toBe('commit')
    expect(await repo.git('for-each-ref', 'refs/pull')).toBe('')
    await repo.git('remote', 'set-url', 'origin', 'git@github.com:acme/app.git')
    expect((await github.read('w')).pr?.missingCommits).toEqual([])
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

  describe('actions', () => {
    /** A gh that has the fixture PR open, answers `repo view` and `api user`, and records the rest. */
    const ghWithPr = (raw: object = RAW_PR, failing?: (args: string[]) => GhRun | undefined) =>
      fakeGh((args) => {
        const failed = failing?.(args)
        if (failed) return failed
        if (args[0] === 'pr' && args[1] === 'list') return ok(JSON.stringify([raw]))
        if (args[0] === 'repo') return ok(JSON.stringify({ mergeCommitAllowed: false, squashMergeAllowed: true, rebaseMergeAllowed: true, viewerPermission: 'WRITE' }))
        if (args[0] === 'api' && args[1] === 'user') return ok('octo\n')
        return ok()
      })

    it('reads merge methods, permission and the viewer with the PR', async () => {
      const { ready, github } = service(ghWithPr())
      await ready
      expect(await github.read('w')).toMatchObject({ viewer: 'octo', mergeMethods: ['squash', 'rebase'], canMerge: true })
    })

    it('merges exactly the head it showed, deletes the branch on GitHub itself, never locally', async () => {
      const gh = ghWithPr({ ...RAW_PR, headRefOid: 'c'.repeat(40) })
      const { ready, github } = service(gh)
      await ready
      const result = await github.act('w', { kind: 'merge', method: 'squash', deleteBranch: true })
      expect(result.message).toBe('Merged #7 into main and deleted feat/thing on GitHub.')
      const merge = gh.calls.find((args) => args[1] === 'merge')
      expect(merge).toEqual(['pr', 'merge', '7', '--squash', '--match-head-commit', 'c'.repeat(40)])
      expect(gh.calls).toContainEqual(['api', '-X', 'DELETE', 'repos/{owner}/{repo}/git/refs/heads/feat%2Fthing'])
      expect(gh.calls.flat()).not.toContain('--delete-branch')
    })

    it('turns on auto-merge instead, and deletes nothing', async () => {
      const gh = ghWithPr()
      const { ready, github } = service(gh)
      await ready
      expect((await github.act('w', { kind: 'merge', method: 'rebase', auto: true, deleteBranch: true })).message).toMatch(/Auto-merge is on/)
      expect(gh.calls.some((args) => args.includes('DELETE'))).toBe(false)
    })

    it('posts a review with local comments inline, then marks them posted', async () => {
      const comment = (id: string, side: 'old' | 'new'): ReviewComment => ({ id, worktreeId: 'w', file: 'a.txt', line: 3, side, text: `note ${id}`, createdAt: 0, sent: false })
      const review = fakeReview([comment('c1', 'new'), comment('c2', 'old'), comment('c3', 'new')])
      const inputs: string[] = []
      const gh = ghWithPr({ ...RAW_PR, headRefOid: 'd'.repeat(40) })
      const recording: GhRunner = async (cwd, args, options) => {
        if (options?.input) inputs.push(options.input)
        return gh(cwd, args, options)
      }
      const { ready, github } = service(recording, undefined, review)
      await ready
      const result = await github.act('w', { kind: 'review', event: 'request-changes', body: 'Please fix', commentIds: ['c1', 'c2'] })
      expect(result.message).toBe('Requested changes on #7 with 2 inline comments.')
      expect(gh.calls).toContainEqual(['api', '-X', 'POST', 'repos/{owner}/{repo}/pulls/7/reviews', '--input', '-'])
      expect(JSON.parse(inputs[0]!)).toEqual({
        commit_id: 'd'.repeat(40),
        event: 'REQUEST_CHANGES',
        body: 'Please fix',
        comments: [
          { path: 'a.txt', line: 3, side: 'RIGHT', body: 'note c1' },
          { path: 'a.txt', line: 3, side: 'LEFT', body: 'note c2' }
        ]
      })
      expect(review.posted).toEqual([{ ids: ['c1', 'c2'], label: 'github#7' }])
    })

    it('refuses an empty non-approval review, and approves without a body', async () => {
      const { ready, github } = service(ghWithPr())
      await ready
      await expect(github.act('w', { kind: 'review', event: 'comment', body: ' ' })).rejects.toMatchObject({ code: 'empty_review' })
      expect((await github.act('w', { kind: 'review', event: 'approve' })).message).toBe('Approved #7.')
    })

    it('says what GitHub said when it refuses', async () => {
      const refusal = { found: true, exitCode: 1, stdout: '', stderr: 'gh: Unprocessable Entity (HTTP 422)\n{"message":"Unprocessable Entity","errors":["Can not approve your own pull request"]}' }
      const { ready, github } = service(ghWithPr(RAW_PR, (args) => (args[0] === 'api' && args[3]?.endsWith('/reviews') ? refusal : undefined)))
      await ready
      await expect(github.act('w', { kind: 'review', event: 'approve' })).rejects.toMatchObject({ status: 502, message: 'Unprocessable Entity: Can not approve your own pull request' })
    })

    it('comments through stdin, flips draft state, closes and reopens', async () => {
      const inputs: string[] = []
      const gh = ghWithPr()
      const recording: GhRunner = async (cwd, args, options) => {
        if (options?.input) inputs.push(options.input)
        return gh(cwd, args, options)
      }
      const { ready, github } = service(recording)
      await ready
      await github.act('w', { kind: 'comment', body: 'LGTM, `rm -rf` safe?' })
      await github.act('w', { kind: 'ready', ready: false })
      await github.act('w', { kind: 'close' })
      await github.act('w', { kind: 'reopen' })
      expect(inputs).toEqual(['LGTM, `rm -rf` safe?'])
      expect(gh.calls.filter((args) => args[0] === 'pr' && args[1] !== 'list')).toEqual([
        ['pr', 'comment', '7', '--body-file', '-'],
        ['pr', 'ready', '7', '--undo'],
        ['pr', 'close', '7'],
        ['pr', 'reopen', '7']
      ])
    })

    it('edits reviewers, assignees, labels and the milestone through gh pr edit', async () => {
      const gh = ghWithPr()
      const { ready, github } = service(gh)
      await ready
      expect((await github.act('w', { kind: 'reviewers', add: ['pal', 'acme/core'], remove: ['rev'] })).message).toBe('Reviewers: added pal, acme/core; removed rev.')
      await github.act('w', { kind: 'assignees', add: ['octo'] })
      await github.act('w', { kind: 'labels', remove: ['bug'] })
      await github.act('w', { kind: 'milestone', milestone: 'v2' })
      await github.act('w', { kind: 'milestone', milestone: null })
      expect((await github.act('w', { kind: 'labels' })).message).toBe('Nothing to change.')
      expect(gh.calls.filter((args) => args[1] === 'edit')).toEqual([
        ['pr', 'edit', '7', '--add-reviewer', 'pal,acme/core', '--remove-reviewer', 'rev'],
        ['pr', 'edit', '7', '--add-assignee', 'octo'],
        ['pr', 'edit', '7', '--remove-label', 'bug'],
        ['pr', 'edit', '7', '--milestone', 'v2'],
        ['pr', 'edit', '7', '--remove-milestone']
      ])
    })

    it('lists who can be asked, labels and open milestones in one query, then remembers them', async () => {
      const answer = { data: { repository: { assignableUsers: { nodes: [{ login: 'zed', name: null }, { login: 'amy', name: 'Amy' }] }, labels: { nodes: [{ name: 'bug', color: 'd73a4a' }] }, milestones: { nodes: [{ title: 'v1' }] } } } }
      const gh = ghWithPr(RAW_PR, (args) => (args[1] === 'graphql' ? ok(JSON.stringify(answer)) : undefined))
      const { ready, github } = service(gh)
      await ready
      expect(await github.options('w')).toEqual({ users: [{ login: 'amy', name: 'Amy' }, { login: 'zed', name: null }], labels: [{ name: 'bug', color: 'd73a4a' }], milestones: ['v1'] })
      await github.options('w')
      const queries = gh.calls.filter((args) => args[1] === 'graphql')
      expect(queries).toHaveLength(1)
      expect(queries[0]).toContain('o=acme')
      expect(queries[0]).toContain('r=app')
    })

    it('re-runs the failed jobs of each failing Actions run once', async () => {
      const raw = {
        ...RAW_PR,
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'a', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/app/actions/runs/11/job/1' },
          { __typename: 'CheckRun', name: 'b', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/app/actions/runs/11/job/2' },
          { __typename: 'CheckRun', name: 'c', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/acme/app/actions/runs/12/job/3' },
          { __typename: 'StatusContext', context: 'ext', state: 'FAILURE', targetUrl: 'https://ci.example/9' }
        ]
      }
      const gh = ghWithPr(raw)
      const { ready, github } = service(gh)
      await ready
      expect((await github.act('w', { kind: 'rerun' })).message).toBe('Re-running the failed jobs of 1 workflow run.')
      expect(gh.calls.filter((args) => args[0] === 'run')).toEqual([['run', 'rerun', '11', '--failed']])

      const { github: clean } = service(ghWithPr())
      await expect(clean.act('w', { kind: 'rerun' })).rejects.toMatchObject({ code: 'nothing_to_rerun' })
    })

    it('gives Files changed the merge base and head when the head is here', async () => {
      await repo.commit({ 'b.txt': 'two\n' }, 'Add b')
      await repo.git('fetch', '-q', bare, '+refs/heads/*:refs/remotes/origin/*')
      const head = await repo.git('rev-parse', 'HEAD')
      const base = await repo.git('rev-parse', 'main')
      const { ready, github } = service(ghWithPr({ ...RAW_PR, headRefOid: head, commits: [{ oid: head }] }))
      await ready
      expect((await github.read('w')).pr?.filesRange).toEqual({ before: base, after: head })

      const { github: absent } = service(ghWithPr({ ...RAW_PR, headRefOid: 'e'.repeat(40), commits: [{ oid: 'e'.repeat(40) }] }))
      expect((await absent.read('w')).pr?.filesRange).toBeNull()
    })
  })

  it('reads the PR review threads, normalized, and holds them with the PR', async () => {
    const answer = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                { id: 'T1', isResolved: true, isOutdated: true, path: 'infra/ecs.tf', line: null, originalLine: 40, diffSide: 'RIGHT', comments: { nodes: [{ databaseId: 1, author: { login: 'sanzog03' }, body: 'secrets?', createdAt: '2026-09-24T19:40:36Z', url: 'https://x/1' }] } },
                { id: 'T2', isResolved: false, isOutdated: false, path: 'api/auth.py', line: 12, originalLine: 12, diffSide: 'LEFT', comments: { nodes: [{ databaseId: 2, author: null, body: 'gone user', createdAt: '2026-09-24T19:41:00Z', url: 'https://x/2' }] } }
              ]
            }
          }
        }
      }
    }
    const gh = fakeGh((args) => (args[0] === 'pr' && args[1] === 'list' ? ok(JSON.stringify([RAW_PR])) : args[1] === 'graphql' ? ok(JSON.stringify(answer)) : ok()))
    const { ready, github } = service(gh)
    await ready
    const threads = await github.threads('w')
    expect(threads.number).toBe(7)
    expect(threads.threads).toEqual([
      { id: 'T1', file: 'infra/ecs.tf', line: null, originalLine: 40, side: 'new', resolved: true, outdated: true, comments: [{ id: '1', author: 'sanzog03', body: 'secrets?', at: '2026-09-24T19:40:36Z', url: 'https://x/1' }] },
      { id: 'T2', file: 'api/auth.py', line: 12, originalLine: 12, side: 'old', resolved: false, outdated: false, comments: [{ id: '2', author: 'ghost', body: 'gone user', at: '2026-09-24T19:41:00Z', url: 'https://x/2' }] }
    ])
    await github.threads('w')
    expect(gh.calls.filter((args) => args[1] === 'graphql')).toHaveLength(1)
    const call = gh.calls.find((args) => args[1] === 'graphql') ?? []
    expect(call).toContain('n=7')
    // Owner and repo go as raw strings: `-F` would turn a repo named "2048" into an Int.
    expect(call.filter((value) => value.startsWith('o=') || value.startsWith('r='))).toHaveLength(2)
    for (const arg of call.filter((value) => value.startsWith('o=') || value.startsWith('r='))) expect(call[call.indexOf(arg) - 1]).toBe('-f')
    // An action changes GitHub's side; the threads are asked for again after it.
    await github.act('w', { kind: 'comment', body: 'x' })
    await github.threads('w')
    expect(gh.calls.filter((args) => args[1] === 'graphql')).toHaveLength(2)
  })

  describe('cache', () => {
    const listCalls = (gh: { calls: string[][] }) => gh.calls.filter((args) => args[0] === 'pr' && args[1] === 'list').length
    const build = (gh: GhRunner, clock: { now: number }) => {
      const ready = repo.git('remote', 'set-url', 'origin', 'git@github.com:acme/app.git').then(() => repo.git('remote', 'set-url', '--push', 'origin', bare))
      const github = new GitHubService({ review: fakeReview(), git: runGit, gh, now: () => clock.now, worktrees: { location: () => ({ path: repo.path, baseBranch: 'main', projectId: 'p' }) } })
      return { ready, github }
    }
    const prGh = () => fakeGh((args) => (args[0] === 'pr' && args[1] === 'list' ? ok(JSON.stringify([RAW_PR])) : ok()))

    it('asks GitHub once within the window, then answers stale at once and refreshes behind', async () => {
      const clock = { now: 1_000_000 }
      const gh = prGh()
      const { ready, github } = build(gh, clock)
      await ready
      expect((await github.read('w')).pr?.number).toBe(7)
      await github.read('w')
      expect(listCalls(gh)).toBe(1)

      clock.now += 25_000
      expect((await github.read('w')).pr?.number).toBe(7)
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(listCalls(gh)).toBe(2)
      // The refresh landed: the next read is served from it without asking again.
      await github.read('w')
      expect(listCalls(gh)).toBe(2)
    })

    it('waits for GitHub when asked for a fresh answer, and after an action', async () => {
      const clock = { now: 1_000_000 }
      const gh = prGh()
      const { ready, github } = build(gh, clock)
      await ready
      await github.read('w')
      await github.read('w', { fresh: true })
      expect(listCalls(gh)).toBe(2)

      await github.act('w', { kind: 'comment', body: 'hi' })
      const afterAct = listCalls(gh)
      await github.read('w')
      expect(listCalls(gh)).toBe(afterAct + 1)
    })

    it('recomputes the local side on every read, cached or not', async () => {
      const clock = { now: 1_000_000 }
      const gh = prGh()
      const { ready, github } = build(gh, clock)
      await ready
      await repo.git('push', '-q', '-u', 'origin', 'feat/thing')
      expect((await github.read('w')).upstream?.ahead).toBe(0)
      await repo.commit({ 'z.txt': 'z\n' }, 'Add z')
      expect((await github.read('w')).upstream?.ahead).toBe(1)
      expect(listCalls(gh)).toBe(1)
    })
  })

  it('lists a repository\'s PRs once per head branch, skips forks, and reuses the answer', async () => {
    const pr = (number: number, head: string, extra: object = {}) => ({ ...RAW_PR, number, headRefName: head, ...extra })
    const listed = [
      pr(9, 'feat/thing', { state: 'MERGED', statusCheckRollup: [] }),
      pr(8, 'feat/thing', { state: 'CLOSED' }),
      pr(7, 'main', { isCrossRepository: true }),
      pr(6, 'fix/other', { isDraft: true, reviewDecision: 'APPROVED', statusCheckRollup: [{ __typename: 'CheckRun', name: 't', status: 'IN_PROGRESS' }] })
    ]
    let now = 0
    const gh = fakeGh((args) => (args[0] === 'pr' ? ok(JSON.stringify(listed)) : ok()))
    await repo.git('remote', 'set-url', 'origin', 'git@github.com:acme/app.git')
    const github = new GitHubService({ review: fakeReview(), git: runGit, gh, now: () => now, worktrees: { location: () => ({ path: repo.path, baseBranch: 'main', projectId: 'p' }) } })

    const res = await github.list(repo.path)
    expect(res.gh.state).toBe('ready')
    expect(res.prs.map((p) => [p.number, p.headBranch, p.state, p.draft, p.reviewDecision, p.checks])).toEqual([
      [9, 'feat/thing', 'MERGED', false, null, null],
      [6, 'fix/other', 'OPEN', true, 'APPROVED', 'pending']
    ])
    await github.list(repo.path)
    expect(gh.calls.filter((args) => args[0] === 'pr')).toHaveLength(1)
    now = 60_000
    await github.list(repo.path)
    expect(gh.calls.filter((args) => args[0] === 'pr')).toHaveLength(2)
  })

  it('passes gh failures through with what gh said', async () => {
    const gh = fakeGh((args) => (args[0] === 'pr' ? { found: true, exitCode: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway\n' } : ok()))
    const { ready, github } = service(gh)
    await ready
    await expect(github.read('w')).rejects.toMatchObject({ status: 502, code: 'gh_failed', message: 'HTTP 502: Bad Gateway' })
  })
})
