/**
 * A worktree's GitHub pull request — the read side of the Git tab's Pull request pane, plus the
 * two writes it offers: push the branch, and open a PR from it.
 *
 * Everything runs on demand. Nothing is checked at boot: `gh` is looked for the first time the
 * pane opens, and a working login is remembered for a few minutes so the pane's refreshes do not
 * each pay for `gh auth status` (which goes to the network). A failed check is never remembered,
 * so "Check again" after installing or signing in answers at once.
 */
import type { CreatePullRequestInput, GhStatus, PullRequest, PullRequestCheck, PullRequestEvent, PullRequestResponse, PushResult, UpstreamStatus } from '@canopy/shared'

import type { GitRunner } from '../git/exec'
import { ApiError, badRequest, conflict } from '../lib/errors'
import type { WorktreesService } from '../worktrees/service'
import type { GhRunner } from './gh'

/** How long a working `gh` login is trusted before it is asked again. */
const AUTH_TTL_MS = 5 * 60_000
const PUSH_TIMEOUT_MS = 120_000

/** Every field the pane shows, in one `gh pr list` call. */
const PR_FIELDS = [
  'number',
  'title',
  'body',
  'url',
  'state',
  'isDraft',
  'author',
  'baseRefName',
  'headRefName',
  'createdAt',
  'updatedAt',
  'mergedAt',
  'closedAt',
  'additions',
  'deletions',
  'changedFiles',
  'commits',
  'reviewDecision',
  'mergeable',
  'statusCheckRollup',
  'reviews',
  'comments'
].join(',')

/**
 * Git must not stop to ask for an HTTPS password: there is nobody to type it. SSH is left to the
 * user's own config (an agent, the keychain, core.sshCommand); the push timeout bounds the rest.
 */
const NO_PROMPT = { GIT_TERMINAL_PROMPT: '0' }

interface Deps {
  git: GitRunner
  gh: GhRunner
  worktrees: Pick<WorktreesService, 'location'>
  now?: () => number
}

/** `owner/name` and host from any of the URL shapes git accepts for a remote. */
export function parseRemote(url: string): { host: string; repo: string } | null {
  const trimmed = url.trim().replace(/\/+$/, '').replace(/\.git$/, '')
  // scp-like: git@github.com:owner/name
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(trimmed)
  if (scp && !/^[a-z]+:\/\//i.test(trimmed)) return split(scp[1]!, scp[2]!)
  try {
    const parsed = new URL(trimmed)
    return split(parsed.hostname, parsed.pathname.replace(/^\/+/, ''))
  } catch {
    return null
  }
}

function split(host: string, path: string): { host: string; repo: string } | null {
  const parts = path.split('/').filter(Boolean)
  if (parts.length < 2) return null
  return { host: host.toLowerCase(), repo: parts.slice(-2).join('/') }
}

/** The first non-blank line gh printed, which is where it says what went wrong. */
const firstLine = (text: string): string | null => text.trim().split('\n').find((line) => line.trim().length > 0)?.trim() ?? null

type RawCheck = {
  __typename?: string
  name?: string
  context?: string
  workflowName?: string
  status?: string
  conclusion?: string
  state?: string
  detailsUrl?: string
  targetUrl?: string
}

function outcomeOf(check: RawCheck): PullRequestCheck['outcome'] {
  if (check.__typename === 'StatusContext') {
    if (check.state === 'SUCCESS') return 'pass'
    if (check.state === 'FAILURE' || check.state === 'ERROR') return 'fail'
    return 'pending'
  }
  if (check.status !== 'COMPLETED') return 'pending'
  switch (check.conclusion) {
    case 'SUCCESS':
      return 'pass'
    case 'SKIPPED':
      return 'skipped'
    case 'NEUTRAL':
    case 'STALE':
      return 'neutral'
    default:
      return 'fail'
  }
}

type RawPr = {
  number: number
  title: string
  body?: string
  url: string
  state: PullRequest['state']
  isDraft?: boolean
  author?: { login?: string }
  baseRefName: string
  headRefName: string
  createdAt: string
  updatedAt: string
  mergedAt?: string | null
  closedAt?: string | null
  additions?: number
  deletions?: number
  changedFiles?: number
  commits?: unknown[]
  reviewDecision?: string
  mergeable?: string
  statusCheckRollup?: RawCheck[]
  reviews?: Array<{ author?: { login?: string }; body?: string; state?: string; submittedAt?: string }>
  comments?: Array<{ author?: { login?: string }; body?: string; createdAt?: string; isMinimized?: boolean }>
}

/** GitHub's zero timestamp, which `gh` prints for "never". */
const when = (value: string | null | undefined): string | null => (value && !value.startsWith('0001-') ? value : null)

export function toPullRequest(raw: RawPr): PullRequest {
  const reviews: PullRequestEvent[] = (raw.reviews ?? [])
    // A review with no body and a plain COMMENTED verdict is the wrapper GitHub puts around inline
    // comments; the pane does not show those, and an empty card says nothing.
    .filter((review) => (review.body ?? '').trim().length > 0 || review.state !== 'COMMENTED')
    .map((review) => ({ kind: 'review', author: review.author?.login ?? 'ghost', body: review.body ?? '', verdict: review.state ?? null, at: review.submittedAt ?? raw.createdAt }))
  const comments: PullRequestEvent[] = (raw.comments ?? [])
    .filter((comment) => !comment.isMinimized)
    .map((comment) => ({ kind: 'comment', author: comment.author?.login ?? 'ghost', body: comment.body ?? '', verdict: null, at: comment.createdAt ?? raw.createdAt }))
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? '',
    url: raw.url,
    state: raw.state,
    draft: raw.isDraft ?? false,
    author: raw.author?.login ?? 'ghost',
    baseBranch: raw.baseRefName,
    headBranch: raw.headRefName,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    mergedAt: when(raw.mergedAt),
    closedAt: when(raw.closedAt),
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    changedFiles: raw.changedFiles ?? 0,
    commits: raw.commits?.length ?? 0,
    reviewDecision: raw.reviewDecision || null,
    mergeable: raw.mergeable ?? 'UNKNOWN',
    checks: (raw.statusCheckRollup ?? []).map((check) => ({
      name: check.name ?? check.context ?? 'check',
      workflow: check.workflowName || null,
      outcome: outcomeOf(check),
      url: check.detailsUrl || check.targetUrl || null
    })),
    events: [...reviews, ...comments].sort((a, b) => a.at.localeCompare(b.at))
  }
}

/** `feat/add-pr-tab` → "Add pr tab": a starting point for a PR opened from several commits. */
export function titleFromBranch(branch: string): string {
  const words = (branch.split('/').pop() ?? branch).replace(/[-_]+/g, ' ').trim()
  return words.length ? words[0]!.toUpperCase() + words.slice(1) : branch
}

export class GitHubService {
  /** Hosts whose `gh` login worked, and when that was last confirmed. */
  private readonly authed = new Map<string, number>()

  constructor(private readonly deps: Deps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private async branchOf(cwd: string): Promise<string | null> {
    const out = await this.deps.git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'], { okCodes: [0, 1] })
    return out.trim() || null
  }

  /** The remote the branch pushes to, else `origin`, else the first one. */
  private async remote(cwd: string, branch: string | null): Promise<string | null> {
    const remotes = (await this.deps.git(cwd, ['remote'])).split('\n').map((line) => line.trim()).filter(Boolean)
    if (remotes.length === 0) return null
    const configured = branch ? (await this.deps.git(cwd, ['config', '--get', `branch.${branch}.remote`], { okCodes: [0, 1] })).trim() : ''
    if (configured && remotes.includes(configured)) return configured
    return remotes.includes('origin') ? 'origin' : remotes[0]!
  }

  async status(cwd: string, branch: string | null): Promise<GhStatus & { remote: string | null }> {
    const remote = await this.remote(cwd, branch)
    const base = { host: null, repo: null, remoteUrl: null, detail: null, remote }
    if (!remote) return { ...base, state: 'no-remote' }
    const remoteUrl = (await this.deps.git(cwd, ['remote', 'get-url', remote])).trim()
    const parsed = parseRemote(remoteUrl)
    const known = { ...base, remoteUrl, host: parsed?.host ?? null, repo: parsed?.repo ?? null }
    if (!parsed) return { ...known, state: 'not-github' }

    const confirmed = this.authed.get(parsed.host)
    if (confirmed !== undefined && this.now() - confirmed < AUTH_TTL_MS) return { ...known, state: 'ready' }

    const version = await this.deps.gh(cwd, ['--version'])
    if (!version.found) return { ...known, state: 'missing' }
    const auth = await this.deps.gh(cwd, ['auth', 'status', '--hostname', parsed.host])
    if (auth.exitCode === 0) {
      this.authed.set(parsed.host, this.now())
      return { ...known, state: 'ready' }
    }
    // An Enterprise host looks just like any other git host until someone signs in to it, so
    // only a host that says GitHub is taken to be one; the rest are "not GitHub" with the way
    // to sign in to an Enterprise host still offered in the pane.
    const githubish = parsed.host === 'github.com' || parsed.host.includes('github')
    return { ...known, state: githubish ? 'unauthenticated' : 'not-github', detail: firstLine(auth.stderr || auth.stdout) }
  }

  /**
   * The branch's upstream, but only when it is a branch of the same name: a worktree cut from
   * `origin/main` tracks main, and pushing "to its upstream" would push onto main.
   */
  async upstream(cwd: string, branch: string): Promise<UpstreamStatus> {
    const name = (await this.deps.git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { okCodes: [0, 128] })).trim()
    if (!name || name.slice(name.indexOf('/') + 1) !== branch) return { name: null, ahead: null, behind: null }
    const counts = (await this.deps.git(cwd, ['rev-list', '--left-right', '--count', '@{u}...HEAD'])).trim().split(/\s+/)
    return { name, behind: Number(counts[0] ?? 0), ahead: Number(counts[1] ?? 0) }
  }

  private async findPr(cwd: string, branch: string): Promise<PullRequest | null> {
    const run = await this.deps.gh(cwd, ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', PR_FIELDS])
    if (!run.found) throw conflict('gh_missing', 'the GitHub CLI (gh) is not installed on the daemon host')
    if (run.exitCode !== 0) throw new ApiError(502, 'gh_failed', firstLine(run.stderr) ?? `gh pr list exited with ${run.exitCode}`)
    const list = JSON.parse(run.stdout || '[]') as RawPr[]
    return list[0] ? toPullRequest(list[0]) : null
  }

  /** A title and body for a new PR, from what the branch adds over its base. */
  private async suggest(cwd: string, branch: string, base: string, remote: string | null): Promise<{ title: string; body: string }> {
    const remoteBase = remote ? `${remote}/${base}` : null
    const hasRemoteBase = remoteBase ? (await this.deps.git(cwd, ['rev-parse', '--verify', '-q', `refs/remotes/${remoteBase}`], { okCodes: [0, 1] })).trim() : ''
    const from = hasRemoteBase ? remoteBase! : base
    const log = await this.deps.git(cwd, ['log', '--reverse', '--format=%s%x00%b%x1e', `${from}..HEAD`], { okCodes: [0, 128] })
    const commits = log
      .split('\x1e')
      .map((entry) => entry.replace(/^\n/, ''))
      .filter((entry) => entry.trim().length > 0)
      .map((entry) => {
        const [subject = '', body = ''] = entry.split('\x00')
        return { subject: subject.trim(), body: body.trim() }
      })
    if (commits.length === 1) return { title: commits[0]!.subject, body: commits[0]!.body }
    return { title: titleFromBranch(branch), body: commits.map((commit) => `- ${commit.subject}`).join('\n') }
  }

  async read(worktreeId: string): Promise<PullRequestResponse> {
    const { path, baseBranch } = this.deps.worktrees.location(worktreeId)
    const branch = await this.branchOf(path)
    const { remote, ...gh } = await this.status(path, branch)
    const empty = { gh, branch, baseBranch, upstream: null, pr: null, draft: null }
    if (!branch) return empty
    if (gh.state !== 'ready') return { ...empty, upstream: await this.upstream(path, branch) }
    // GitHub is the slow part, so the local reads run alongside it rather than after. The
    // suggestion is a `git log` that is thrown away when a PR turns up — cheaper than waiting
    // for GitHub to say whether it is needed. The base branch itself has nothing to propose.
    const [upstream, pr, suggested] = await Promise.all([
      this.upstream(path, branch),
      this.findPr(path, branch),
      branch === baseBranch ? null : this.suggest(path, branch, baseBranch, remote)
    ])
    return { ...empty, upstream, pr, draft: pr ? null : suggested }
  }

  async push(worktreeId: string): Promise<PushResult> {
    const { path } = this.deps.worktrees.location(worktreeId)
    const branch = await this.branchOf(path)
    if (!branch) throw badRequest('detached', 'a detached worktree has no branch to push')
    await this.pushBranch(path, branch)
    return { upstream: await this.upstream(path, branch) }
  }

  private async pushBranch(cwd: string, branch: string): Promise<void> {
    const remote = await this.remote(cwd, branch)
    if (!remote) throw conflict('no_remote', 'this repository has no remote to push to')
    const upstream = await this.upstream(cwd, branch)
    // The first push names the branch on both sides and records it as the upstream; later ones
    // go where that points. Never `git push` bare: it follows push.default, which may be anything.
    const args = upstream.name ? ['push', remote, `HEAD:refs/heads/${branch}`] : ['push', '--set-upstream', remote, `HEAD:refs/heads/${branch}`]
    await this.deps.git(cwd, args, { env: NO_PROMPT, timeout: PUSH_TIMEOUT_MS })
    if (!upstream.name) await this.deps.git(cwd, ['branch', `--set-upstream-to=${remote}/${branch}`, branch], { okCodes: [0, 128] })
  }

  async create(worktreeId: string, input: CreatePullRequestInput): Promise<PullRequest> {
    const { path, baseBranch } = this.deps.worktrees.location(worktreeId)
    const branch = await this.branchOf(path)
    if (!branch) throw badRequest('detached', 'a detached worktree has no branch to open a pull request from')
    const gh = await this.status(path, branch)
    if (gh.state !== 'ready') throw conflict(`gh_${gh.state.replace('-', '_')}`, 'GitHub is not reachable through gh for this worktree')
    const base = input.base ?? baseBranch
    if (base === branch) throw badRequest('same_branch', `the pull request would merge ${branch} into itself`)

    // GitHub opens a PR from what the remote has, so unpushed commits are pushed first.
    const upstream = await this.upstream(path, branch)
    if (!upstream.name || (upstream.ahead ?? 0) > 0) await this.pushBranch(path, branch)

    const args = ['pr', 'create', '--head', branch, '--base', base, '--title', input.title.trim(), '--body', input.body ?? '']
    if (input.draft) args.push('--draft')
    const run = await this.deps.gh(path, args, { timeout: 60_000 })
    if (run.exitCode !== 0) throw new ApiError(502, 'gh_failed', firstLine(run.stderr) ?? `gh pr create exited with ${run.exitCode}`)
    const pr = await this.findPr(path, branch)
    if (!pr) throw new ApiError(502, 'gh_failed', `gh opened ${firstLine(run.stdout) ?? 'a pull request'} but could not read it back`)
    return pr
  }
}
