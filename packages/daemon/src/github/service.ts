/**
 * A worktree's GitHub pull request — the read side of the Git tab's Pull request pane, plus the
 * two writes it offers: push the branch, and open a PR from it.
 *
 * Everything runs on demand. Nothing is checked at boot: `gh` is looked for the first time the
 * pane opens, and a working login is remembered for a few minutes so the pane's refreshes do not
 * each pay for `gh auth status` (which goes to the network). A failed check is never remembered,
 * so "Check again" after installing or signing in answers at once.
 */
import type { CreatePullRequestInput, GhStatus, MergeMethod, PullRequest, PullRequestAction, PullRequestActionResult, PullRequestCheck, PullRequestEvent, PullRequestResponse, PushResult, UpstreamStatus } from '@canopy/shared'

import type { GitRunner } from '../git/exec'
import type { ReviewService } from '../review/service'
import { ApiError, badRequest, conflict } from '../lib/errors'
import type { WorktreesService } from '../worktrees/service'
import type { GhRunner } from './gh'

/** How long a working `gh` login is trusted before it is asked again. */
const AUTH_TTL_MS = 5 * 60_000
const PUSH_TIMEOUT_MS = 120_000
/** Repository settings (merge methods, the viewer's permission) change rarely; asked again after this. */
const REPO_TTL_MS = 10 * 60_000

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
  'comments',
  'assignees',
  'reviewRequests',
  'latestReviews',
  'labels',
  'milestone',
  'mergeStateStatus',
  'autoMergeRequest',
  'headRefOid'
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
  /** Local line comments, for posting them with a review. */
  review: Pick<ReviewService, 'list' | 'markPosted'>
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

/**
 * What GitHub said, readably. `gh api` prints the API's JSON error (`{"message": …, "errors": […]}`)
 * — for a review, the inline comment that did not land on the diff is named in `errors`.
 */
function githubMessage(stderr: string): string | null {
  const text = stderr.trim()
  const json = text.indexOf('{')
  if (json >= 0) {
    try {
      const parsed = JSON.parse(text.slice(json)) as { message?: string; errors?: unknown[] }
      const details = (parsed.errors ?? []).map((error) => (typeof error === 'string' ? error : (error as { message?: string }).message ?? '')).filter(Boolean)
      if (parsed.message) return [parsed.message, ...details].join(': ')
    } catch {
      // Not JSON after all; the first line is the message.
    }
  }
  return firstLine(text)
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
  commits?: Array<{ oid: string; messageHeadline?: string; authoredDate?: string; committedDate?: string; authors?: Array<{ name?: string; login?: string; email?: string }> }>
  reviewDecision?: string
  mergeable?: string
  statusCheckRollup?: RawCheck[]
  reviews?: Array<{ author?: { login?: string }; body?: string; state?: string; submittedAt?: string }>
  comments?: Array<{ author?: { login?: string }; body?: string; createdAt?: string; isMinimized?: boolean }>
  assignees?: Array<{ login: string; name?: string }>
  reviewRequests?: Array<{ __typename?: string; login?: string; slug?: string; name?: string }>
  latestReviews?: Array<{ author?: { login?: string }; state?: string }>
  labels?: Array<{ name: string; color?: string }>
  milestone?: { title?: string } | null
  mergeStateStatus?: string
  autoMergeRequest?: unknown
  headRefOid?: string
}

const REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING'])

/**
 * One row per reviewer, the way GitHub's sidebar lists them: whoever has reviewed, with their
 * latest verdict, then whoever is still asked. A re-requested reviewer shows as requested —
 * their old verdict is about code that has since changed.
 */
function reviewersOf(raw: RawPr): PullRequest['reviewers'] {
  const requested = (raw.reviewRequests ?? []).map((request) => ({
    name: request.login ?? request.slug ?? request.name ?? 'unknown',
    team: request.__typename === 'Team',
    state: 'requested' as const
  }))
  const asked = new Set(requested.map((reviewer) => reviewer.name))
  const reviewed = (raw.latestReviews ?? [])
    .filter((review) => review.author?.login && !asked.has(review.author.login) && REVIEW_STATES.has(review.state ?? ''))
    .map((review) => ({ name: review.author!.login!, team: false, state: review.state as PullRequest['reviewers'][number]['state'] }))
  return [...reviewed, ...requested]
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
    commitLog: (raw.commits ?? []).map((commit) => {
      const author = commit.authors?.[0]
      return {
        sha: commit.oid,
        shortSha: commit.oid.slice(0, 7),
        author: author?.name || author?.login || 'unknown',
        email: author?.email ?? '',
        at: Date.parse(commit.authoredDate ?? commit.committedDate ?? raw.createdAt),
        subject: commit.messageHeadline ?? '',
        parents: []
      }
    }),
    missingCommits: [],
    assignees: (raw.assignees ?? []).map((person) => ({ login: person.login, name: person.name || null })),
    reviewers: reviewersOf(raw),
    labels: (raw.labels ?? []).map((label) => ({ name: label.name, color: label.color ?? '888888' })),
    milestone: raw.milestone?.title ?? null,
    reviewDecision: raw.reviewDecision || null,
    mergeable: raw.mergeable ?? 'UNKNOWN',
    mergeState: raw.mergeStateStatus ?? 'UNKNOWN',
    autoMerge: Boolean(raw.autoMergeRequest),
    headSha: raw.headRefOid ?? raw.commits?.at(-1)?.oid ?? '',
    filesRange: null,
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

/** GitHub's own order: the button it shows first is a merge commit, then squash, then rebase. */
const METHOD_ORDER: MergeMethod[] = ['merge', 'squash', 'rebase']
const REVIEW_EVENT = { approve: 'APPROVE', 'request-changes': 'REQUEST_CHANGES', comment: 'COMMENT' } as const

interface RepoInfo {
  mergeMethods: MergeMethod[]
  canMerge: boolean
}

export class GitHubService {
  /** Hosts whose `gh` login worked, and when that was last confirmed. */
  private readonly authed = new Map<string, number>()
  /** Per checkout: what the repository allows and what the viewer may do there. */
  private readonly repoInfo = new Map<string, { at: number; info: RepoInfo }>()
  /** Per host: who `gh` is signed in as. */
  private readonly viewers = new Map<string, string>()

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

  private async findPr(cwd: string, branch: string, remote: string | null = null): Promise<PullRequest | null> {
    const run = await this.deps.gh(cwd, ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', PR_FIELDS])
    if (!run.found) throw conflict('gh_missing', 'the GitHub CLI (gh) is not installed on the daemon host')
    if (run.exitCode !== 0) throw new ApiError(502, 'gh_failed', firstLine(run.stderr) ?? `gh pr list exited with ${run.exitCode}`)
    const list = JSON.parse(run.stdout || '[]') as RawPr[]
    if (!list[0]) return null
    const pr = toPullRequest(list[0])
    const missingCommits = await this.missing(cwd, pr.commitLog.map((commit) => commit.sha))
    const headHere = pr.headSha !== '' && !missingCommits.includes(pr.headSha) && (await this.missing(cwd, [pr.headSha])).length === 0
    return { ...pr, missingCommits, filesRange: headHere ? await this.range(cwd, remote, pr.baseBranch, pr.headSha) : null }
  }

  /**
   * What GitHub's Files changed tab shows: the head against its merge base with the target, so
   * commits that landed on the target since the branch was cut are not counted as the PR's.
   */
  private async range(cwd: string, remote: string | null, base: string, head: string): Promise<PullRequest['filesRange']> {
    const target = remote ? `refs/remotes/${remote}/${base}` : `refs/heads/${base}`
    const before = (await this.deps.git(cwd, ['merge-base', target, head], { okCodes: [0, 1, 128] })).trim()
    return /^[0-9a-f]{40}$/.test(before) ? { before, after: head } : null
  }

  /** Merge methods and permission, from `gh repo view`; a failure answers "nothing allowed" rather than throwing. */
  private async repo(cwd: string): Promise<RepoInfo> {
    const cached = this.repoInfo.get(cwd)
    if (cached && this.now() - cached.at < REPO_TTL_MS) return cached.info
    const run = await this.deps.gh(cwd, ['repo', 'view', '--json', 'mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,viewerPermission'])
    if (run.exitCode !== 0) return { mergeMethods: [], canMerge: false }
    const raw = JSON.parse(run.stdout || '{}') as { mergeCommitAllowed?: boolean; squashMergeAllowed?: boolean; rebaseMergeAllowed?: boolean; viewerPermission?: string }
    const allowed: Record<MergeMethod, boolean | undefined> = { merge: raw.mergeCommitAllowed, squash: raw.squashMergeAllowed, rebase: raw.rebaseMergeAllowed }
    const info = {
      mergeMethods: METHOD_ORDER.filter((method) => allowed[method]),
      canMerge: ['ADMIN', 'MAINTAIN', 'WRITE'].includes(raw.viewerPermission ?? '')
    }
    this.repoInfo.set(cwd, { at: this.now(), info })
    return info
  }

  private async viewer(cwd: string, host: string | null): Promise<string | null> {
    const key = host ?? 'github.com'
    const known = this.viewers.get(key)
    if (known) return known
    const run = await this.deps.gh(cwd, ['api', 'user', '--jq', '.login'])
    const login = run.exitCode === 0 ? run.stdout.trim() : ''
    if (!login) return null
    this.viewers.set(key, login)
    return login
  }

  /** Which of `shas` this repository has no commit for; one `cat-file` for the lot. */
  private async missing(cwd: string, shas: string[]): Promise<string[]> {
    if (shas.length === 0) return []
    const out = await this.deps.git(cwd, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: `${shas.join('\n')}\n` })
    const lines = out.split('\n')
    return shas.filter((_sha, index) => !(lines[index] ?? '').endsWith(' commit'))
  }

  /**
   * Brings the PR's commits into this repository without touching any branch: GitHub keeps every
   * PR's head at `refs/pull/N/head`, which covers commits pushed from another machine and PRs
   * from forks. Only the objects are wanted, so nothing is written to a local ref.
   */
  async fetchPr(worktreeId: string): Promise<{ fetched: number }> {
    const { path } = this.deps.worktrees.location(worktreeId)
    const branch = await this.branchOf(path)
    if (!branch) throw badRequest('detached', 'a detached worktree has no pull request')
    const pr = await this.findPr(path, branch)
    if (!pr) throw conflict('no_pull_request', `no pull request for ${branch}`)
    if (pr.missingCommits.length === 0) return { fetched: 0 }
    const remote = await this.remote(path, branch)
    if (!remote) throw conflict('no_remote', 'this repository has no remote to fetch from')
    await this.deps.git(path, ['fetch', '--no-tags', '--no-write-fetch-head', remote, `refs/pull/${pr.number}/head`], { env: NO_PROMPT, timeout: PUSH_TIMEOUT_MS })
    return { fetched: pr.missingCommits.length }
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

  /**
   * What a new PR can target, from the remote-tracking refs: no network, as fresh as the last
   * fetch. The suggestion is the worktree's own base when GitHub has it — a base recorded at
   * creation can name a branch that was never pushed or was since deleted — else the branch
   * the remote calls its default.
   */
  private async bases(cwd: string, remote: string | null, branch: string, baseBranch: string): Promise<{ bases: string[]; suggestedBase: string | null }> {
    if (!remote) return { bases: [], suggestedBase: null }
    const prefix = `refs/remotes/${remote}/`
    const [refs, head] = await Promise.all([
      this.deps.git(cwd, ['for-each-ref', '--format=%(refname)', prefix]),
      this.deps.git(cwd, ['symbolic-ref', '-q', `${prefix}HEAD`], { okCodes: [0, 1, 128] })
    ])
    const names = refs
      .split('\n')
      .map((ref) => ref.trim().slice(prefix.length))
      .filter((name) => name.length > 0 && name !== 'HEAD' && name !== branch)
      .sort((a, b) => a.localeCompare(b))
    const remoteDefault = head.trim().startsWith(prefix) ? head.trim().slice(prefix.length) : null
    const suggestedBase = [baseBranch, remoteDefault, 'main', 'master'].find((name): name is string => !!name && names.includes(name)) ?? names[0] ?? null
    return { bases: names, suggestedBase }
  }

  async read(worktreeId: string): Promise<PullRequestResponse> {
    const { path, baseBranch } = this.deps.worktrees.location(worktreeId)
    const branch = await this.branchOf(path)
    const { remote, ...gh } = await this.status(path, branch)
    const empty = {
      gh,
      branch,
      baseBranch,
      upstream: null,
      pr: null,
      draft: null,
      bases: [] as string[],
      suggestedBase: null,
      viewer: null,
      mergeMethods: [] as MergeMethod[],
      canMerge: false
    }
    if (!branch) return empty
    if (gh.state !== 'ready') return { ...empty, upstream: await this.upstream(path, branch) }
    // GitHub is the slow part, so the local reads run alongside it rather than after. The
    // suggestion is a `git log` that is thrown away when a PR turns up — cheaper than waiting
    // for GitHub to say whether it is needed. The base branch itself has nothing to propose.
    const onBase = branch === baseBranch
    const [upstream, pr, suggested, targets, repo, viewer] = await Promise.all([
      this.upstream(path, branch),
      this.findPr(path, branch, remote),
      onBase ? null : this.suggest(path, branch, baseBranch, remote),
      onBase ? null : this.bases(path, remote, branch, baseBranch),
      this.repo(path),
      this.viewer(path, gh.host)
    ])
    if (pr) return { ...empty, upstream, pr, viewer, ...repo }
    return { ...empty, upstream, draft: suggested, ...(targets ?? {}) }
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

  /** One action on the branch's PR. Each re-reads the PR first, so it acts on what GitHub has now. */
  async act(worktreeId: string, action: PullRequestAction): Promise<PullRequestActionResult> {
    const { path } = this.deps.worktrees.location(worktreeId)
    const branch = await this.branchOf(path)
    if (!branch) throw badRequest('detached', 'a detached worktree has no pull request')
    const gh = await this.status(path, branch)
    if (gh.state !== 'ready') throw conflict(`gh_${gh.state.replace('-', '_')}`, 'GitHub is not reachable through gh for this worktree')
    const pr = await this.findPr(path, branch, gh.remote)
    if (!pr) throw conflict('no_pull_request', `no pull request for ${branch}`)
    const n = String(pr.number)
    const run = async (args: string[], input?: string): Promise<string> => {
      const result = await this.deps.gh(path, args, { timeout: 60_000, input })
      if (result.exitCode !== 0) throw new ApiError(502, 'gh_failed', githubMessage(result.stderr) ?? `gh ${args.slice(0, 2).join(' ')} exited with ${result.exitCode}`)
      return result.stdout
    }

    switch (action.kind) {
      case 'merge': {
        if (pr.state !== 'OPEN') throw conflict('not_open', `#${n} is ${pr.state.toLowerCase()}`)
        const method = action.method ?? 'merge'
        // --match-head-commit: merge exactly what the pane showed, never a commit pushed since.
        const args = ['pr', 'merge', n, `--${method}`, '--match-head-commit', pr.headSha]
        if (action.auto) args.push('--auto')
        if (action.subject?.trim()) args.push('--subject', action.subject.trim())
        if (action.body !== undefined && action.body.trim()) args.push('--body', action.body)
        // Not gh's --delete-branch: that also deletes the local branch and checks out the base,
        // which fails in a worktree (the base is checked out elsewhere) and is not ours to do.
        await run(args)
        if (action.auto) return { message: `Auto-merge is on for #${n}: GitHub merges it once its requirements pass.` }
        if (action.deleteBranch) await run(['api', '-X', 'DELETE', `repos/{owner}/{repo}/git/refs/heads/${encodeURIComponent(pr.headBranch)}`])
        // The target moved on GitHub; fetching it lets the worktree's merged check see it.
        if (gh.remote) await this.deps.git(path, ['fetch', '--no-tags', gh.remote, pr.baseBranch], { env: NO_PROMPT, timeout: PUSH_TIMEOUT_MS, okCodes: [0, 1, 128] })
        return { message: `Merged #${n} into ${pr.baseBranch}${action.deleteBranch ? ` and deleted ${pr.headBranch} on GitHub` : ''}.` }
      }
      case 'review': {
        const event = REVIEW_EVENT[action.event]
        const body = action.body ?? ''
        if (event !== 'APPROVE' && body.trim() === '' && (action.commentIds ?? []).length === 0) {
          throw badRequest('empty_review', 'a review that is not an approval needs a comment')
        }
        const wanted = new Set(action.commentIds ?? [])
        const comments = this.deps.review.list(worktreeId).filter((comment) => wanted.has(comment.id))
        const payload = {
          commit_id: pr.headSha,
          event,
          body,
          comments: comments.map((comment) => ({ path: comment.file, line: comment.line, side: comment.side === 'old' ? 'LEFT' : 'RIGHT', body: comment.text }))
        }
        await run(['api', '-X', 'POST', `repos/{owner}/{repo}/pulls/${n}/reviews`, '--input', '-'], JSON.stringify(payload))
        if (comments.length) this.deps.review.markPosted(worktreeId, comments.map((comment) => comment.id), `github#${n}`)
        const verb = event === 'APPROVE' ? 'Approved' : event === 'REQUEST_CHANGES' ? 'Requested changes on' : 'Reviewed'
        return { message: `${verb} #${n}${comments.length ? ` with ${comments.length} inline comment${comments.length === 1 ? '' : 's'}` : ''}.` }
      }
      case 'comment':
        await run(['pr', 'comment', n, '--body-file', '-'], action.body)
        return { message: `Commented on #${n}.` }
      case 'ready':
        await run(action.ready ? ['pr', 'ready', n] : ['pr', 'ready', n, '--undo'])
        return { message: action.ready ? `#${n} is ready for review.` : `#${n} is a draft again.` }
      case 'close':
        await run(['pr', 'close', n])
        return { message: `Closed #${n}.` }
      case 'reopen':
        await run(['pr', 'reopen', n])
        return { message: `Reopened #${n}.` }
      case 'rerun': {
        const runs = new Set<string>()
        for (const check of pr.checks) {
          const id = check.outcome === 'fail' ? /\/actions\/runs\/(\d+)/.exec(check.url ?? '')?.[1] : undefined
          if (id) runs.add(id)
        }
        if (runs.size === 0) throw badRequest('nothing_to_rerun', 'no failed GitHub Actions checks to re-run')
        for (const id of runs) await run(['run', 'rerun', id, '--failed'])
        return { message: `Re-running the failed jobs of ${runs.size} workflow run${runs.size === 1 ? '' : 's'}.` }
      }
    }
  }
}
