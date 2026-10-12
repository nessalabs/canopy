/**
 * A repository's issues and PRs, for the composer's `#` menu and the issue view: a search, one
 * thread with its timeline, and the files people attached in it.
 *
 * Like the PR pane, everything goes through `gh` with its own login; GitHub's REST shapes are
 * turned into the shared ones here. Attachments are the exception: they are plain HTTPS
 * downloads, which work without a login for public repositories and are retried with `gh`'s
 * token for private ones.
 */
import { isAttachmentUrl, type GhStatus, type GitHubAttachment, type IssueFilter, type IssueSearchResponse, type IssueSummary, type IssueThread, type IssueTimelineItem } from '@canopy/shared'

import { ApiError, badRequest } from '../lib/errors'
import type { GhRunner } from './gh'

/** Searches as the `#` menu is typed into; a short memory spares GitHub's search rate limit. */
const SEARCH_TTL_MS = 30_000
const THREAD_TTL_MS = 20_000
const SEARCH_LIMIT = 30
/** Attachments are read as text in a pane; past this it is not a document anyone reads there. */
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024

type Raw = Record<string, any>

export interface IssuesDeps {
  gh: GhRunner
  /** Whether `gh` can talk to GitHub for this checkout, and which repository it is. */
  status: (cwd: string) => Promise<GhStatus>
  fetch?: typeof fetch
  now?: () => number
}

const login = (user: Raw | null | undefined): string | null => (typeof user?.login === 'string' ? user.login : null)

/** A REST issue (which may be a PR) as the menu lists it. */
export function toIssueSummary(raw: Raw): IssueSummary {
  const pr = raw.pull_request as Raw | undefined
  const state = pr?.merged_at ? 'MERGED' : String(raw.state).toUpperCase() === 'OPEN' ? 'OPEN' : 'CLOSED'
  return {
    number: Number(raw.number),
    kind: pr ? 'pr' : 'issue',
    title: String(raw.title ?? ''),
    state,
    url: String(raw.html_url ?? ''),
    author: login(raw.user),
    updatedAt: String(raw.updated_at ?? '')
  }
}

/** Events that are bookkeeping rather than something that happened to the issue. */
const QUIET = new Set(['mentioned', 'subscribed', 'unsubscribed', 'comment_deleted'])

const quoted = (text: unknown): string => `“${String(text ?? '').split('\n')[0]}”`

/** How each timeline event reads after the actor's name; unlisted events read as their own name. */
const EVENT_TEXT: Record<string, (event: Raw) => string> = {
  closed: () => 'closed this',
  reopened: () => 'reopened this',
  merged: () => 'merged this',
  assigned: (e) => (login(e.assignee) === login(e.actor) ? 'self-assigned this' : `assigned ${login(e.assignee) ?? 'someone'}`),
  unassigned: (e) => `unassigned ${login(e.assignee) ?? 'someone'}`,
  labeled: (e) => `added the ${quoted(e.label?.name)} label`,
  unlabeled: (e) => `removed the ${quoted(e.label?.name)} label`,
  renamed: (e) => `changed the title from ${quoted(e.rename?.from)} to ${quoted(e.rename?.to)}`,
  milestoned: (e) => `added this to the ${quoted(e.milestone?.title)} milestone`,
  demilestoned: (e) => `removed this from the ${quoted(e.milestone?.title)} milestone`,
  'cross-referenced': (e) => `mentioned this in #${e.source?.issue?.number ?? '?'}`,
  referenced: (e) => `referenced this in commit ${String(e.commit_id ?? '').slice(0, 7)}`,
  committed: (e) => `committed ${quoted(e.message)}`,
  review_requested: (e) => `requested a review from ${login(e.requested_reviewer) ?? e.requested_team?.name ?? 'someone'}`,
  review_request_removed: (e) => `removed the review request for ${login(e.requested_reviewer) ?? 'someone'}`,
  reviewed: (e) => (e.state === 'approved' ? 'approved these changes' : e.state === 'changes_requested' ? 'requested changes' : 'reviewed'),
  head_ref_force_pushed: () => 'force-pushed the branch',
  head_ref_deleted: () => 'deleted the branch',
  ready_for_review: () => 'marked this ready for review',
  convert_to_draft: () => 'marked this as a draft',
  added_to_project_v2: () => 'added this to a project',
  removed_from_project_v2: () => 'removed this from a project',
  project_v2_item_status_changed: () => 'moved this in a project',
  parent_issue_added: () => 'added a parent issue',
  parent_issue_removed: () => 'removed a parent issue',
  sub_issue_added: () => 'added a sub-issue',
  sub_issue_removed: () => 'removed a sub-issue',
  connected: () => 'linked a pull request',
  disconnected: () => 'unlinked a pull request',
  locked: () => 'locked the conversation',
  unlocked: () => 'unlocked the conversation',
  pinned: () => 'pinned this',
  unpinned: () => 'unpinned this',
  transferred: () => 'transferred this'
}

/** One REST timeline entry in the shared shape; null for the bookkeeping nobody reads. */
export function toTimelineItem(raw: Raw, index: number): IssueTimelineItem | null {
  const event = String(raw.event ?? '')
  if (QUIET.has(event)) return null
  const createdAt = String(raw.created_at ?? raw.submitted_at ?? raw.committer?.date ?? '')
  const id = String(raw.node_id ?? raw.id ?? raw.sha ?? `${event}-${index}`)
  // A comment, or a review someone wrote something in, reads as what they wrote.
  if (event === 'commented' || (event === 'reviewed' && raw.body)) {
    return { type: 'comment', id, author: login(raw.user ?? raw.actor), createdAt, body: String(raw.body ?? ''), url: raw.html_url ?? null }
  }
  const text = EVENT_TEXT[event]?.(raw) ?? event.replace(/[_-]/g, ' ')
  const actor = login(raw.actor ?? raw.user) ?? (event === 'committed' ? (raw.author?.name ?? null) : null)
  const ref = event === 'cross-referenced' ? (raw.source?.issue?.number ?? null) : null
  return { type: 'event', id, actor, createdAt, event, text, ref }
}

/** What GitHub search is asked: this repository, the one kind, open only unless asked, the words typed. */
export const searchQuery = (repo: string, q: string, { kind, state }: IssueFilter): string =>
  [`repo:${repo}`, kind === 'pr' ? 'is:pr' : 'is:issue', state === 'open' ? 'is:open' : '', q].filter(Boolean).join(' ')

/** `249` or `#249`: a number to look up directly rather than search for. */
const asNumber = (q: string): number | null => (/^#?\d+$/.test(q.trim()) ? Number(q.trim().replace('#', '')) : null)

export class IssuesService {
  private readonly memo = new Map<string, { at: number; value: Promise<unknown> }>()

  constructor(private readonly deps: IssuesDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** One answer per key within `ttl`; a failure is forgotten so the next ask tries again. */
  private remember<T>(key: string, ttl: number, read: () => Promise<T>): Promise<T> {
    const cached = this.memo.get(key)
    if (cached && this.now() - cached.at < ttl) return cached.value as Promise<T>
    const value = read()
    this.memo.set(key, { at: this.now(), value })
    value.catch(() => this.memo.delete(key))
    return value
  }

  /** `gh api` as JSON; `lines` reads one JSON value per line (a paginated `--jq '.[]'`). */
  private async api(cwd: string, args: string[], lines = false): Promise<any> {
    const run = await this.deps.gh(cwd, ['api', ...args])
    if (run.exitCode !== 0) {
      const message = run.stderr.trim().split('\n')[0] || `gh api exited with ${run.exitCode}`
      throw new ApiError(/not found/i.test(run.stderr) ? 404 : 502, 'gh_failed', message)
    }
    if (!lines) return JSON.parse(run.stdout || 'null')
    return run.stdout
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line))
  }

  async search(cwd: string, q: string, filter: IssueFilter = { kind: 'issue', state: 'open' }): Promise<IssueSearchResponse> {
    const gh = await this.deps.status(cwd)
    if (gh.state !== 'ready' || !gh.repo) return { gh, items: [] }
    const repo = gh.repo
    const items = await this.remember(`search:${repo}:${filter.kind}:${filter.state}:${q}`, SEARCH_TTL_MS, async () => {
      const number = asNumber(q)
      if (number !== null) {
        const one = await this.api(cwd, [`repos/${repo}/issues/${number}`]).catch((error: unknown) => {
          if (error instanceof ApiError && error.status === 404) return null
          throw error
        })
        return one ? [toIssueSummary(one)] : []
      }
      const found = await this.api(cwd, ['-X', 'GET', 'search/issues', '-f', `q=${searchQuery(repo, q, filter)}`, '-f', 'sort=updated', '-f', `per_page=${SEARCH_LIMIT}`])
      return ((found?.items ?? []) as Raw[]).map(toIssueSummary)
    })
    return { gh, items }
  }

  async read(cwd: string, number: number): Promise<IssueThread> {
    const gh = await this.deps.status(cwd)
    if (gh.state !== 'ready' || !gh.repo) throw new ApiError(409, 'gh_unavailable', `GitHub is not available here (${gh.state})`)
    const repo = gh.repo
    return this.remember(`thread:${repo}:${number}`, THREAD_TTL_MS, async () => {
      const [issue, events] = await Promise.all([
        this.api(cwd, [`repos/${repo}/issues/${number}`]),
        this.api(cwd, ['--paginate', `repos/${repo}/issues/${number}/timeline`, '--jq', '.[]'], true)
      ])
      const timeline = (events as Raw[]).map(toTimelineItem).filter((item): item is IssueTimelineItem => item !== null)
      return { ...toIssueSummary(issue), body: String(issue.body ?? ''), createdAt: String(issue.created_at ?? ''), repo, timeline }
    })
  }

  /** A file attached on GitHub, as text; tried without a login first, then with `gh`'s. */
  async attachment(cwd: string, url: string): Promise<GitHubAttachment> {
    if (!isAttachmentUrl(url)) throw badRequest('not_an_attachment', 'only files attached on GitHub can be opened here')
    const fetcher = this.deps.fetch ?? fetch
    let response = await fetcher(url, { redirect: 'follow' })
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      const token = (await this.deps.gh(cwd, ['auth', 'token'])).stdout.trim()
      if (token) response = await fetcher(url, { redirect: 'follow', headers: { Authorization: `token ${token}` } })
    }
    if (!response.ok) throw new ApiError(502, 'attachment_failed', `GitHub answered ${response.status} for this attachment`)
    if (Number(response.headers.get('content-length') ?? 0) > MAX_ATTACHMENT_BYTES) throw new ApiError(413, 'attachment_too_large', 'this attachment is too large to read here')
    const text = await response.text()
    if (text.length > MAX_ATTACHMENT_BYTES || text.includes('\u0000')) throw new ApiError(415, 'attachment_binary', 'this attachment is not a text file')
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? 'attachment')
    return { url, name, contentType: response.headers.get('content-type') ?? 'text/plain', text }
  }
}
