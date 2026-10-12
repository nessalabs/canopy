/**
 * A repository's issues and PRs, for the composer's `#` menu and the issue view: a search, one
 * thread with its timeline, and the files people attached in it.
 *
 * Like the PR pane, everything goes through `gh` with its own login; GitHub's REST shapes are
 * turned into the shared ones here. Attachments are the exception: they are plain HTTPS
 * downloads, which work without a login for public repositories and are retried with `gh`'s
 * token for private ones.
 */
import { isAttachmentUrl, type GhStatus, type GitHubAttachment, type IssueAssignees, type IssueFilter, type IssueSearchResponse, type IssueSummary, type IssueThread, type IssueTimelineItem } from '@canopy/shared'

import { ApiError, badRequest } from '../lib/errors'
import type { GhRunner } from './gh'
import type { IssueCache } from './issue-cache'

/** How old the local copy may be before a search starts catching it up behind its answer. */
const SYNC_TTL_MS = 30_000
/** Each catch-up re-reads a little before the last one, so clock skew with GitHub loses nothing. */
const SYNC_OVERLAP_MS = 60_000
/**
 * How long a search on a stale copy waits for the catch-up — usually one quick request — so an
 * issue opened a minute ago is in the very answer that went looking for it. Past this the answer
 * comes from the copy and the catch-up finishes behind it.
 */
const CATCH_UP_WAIT_MS = 1_500
/**
 * How often, at most, the copy's count is checked against GitHub's. A catch-up hears about every
 * issue that changed — closed, reopened, retitled, reassigned — but not one deleted or
 * transferred away; a count that no longer matches is how those show, and only then is the copy
 * rebuilt whole.
 */
const DRIFT_CHECK_MS = 15 * 60_000
/** A first sync of a large repository pages through all of it. */
const SYNC_TIMEOUT_MS = 180_000
/** Attachments are read as text in a pane; past this it is not a document anyone reads there. */
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024

type Raw = Record<string, any>

export interface IssuesDeps {
  gh: GhRunner
  /** Whether `gh` can talk to GitHub for this checkout, and which repository it is. */
  status: (cwd: string) => Promise<GhStatus>
  /** The local copy searches are answered from. */
  cache: IssueCache
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
    assignees: ((raw.assignees ?? []) as Raw[]).map(login).filter((name): name is string => name !== null),
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

/** The repository an issue lives in now, when that is not `repo` — it was transferred. */
export function movedTo(issue: Raw, repo: string): string | null {
  const home = /\/repos\/([^/]+\/[^/]+)$/.exec(String(issue.repository_url ?? ''))?.[1]
  return home && home.toLowerCase() !== repo.toLowerCase() ? home : null
}

/**
 * A repository as `gh` reaches it: the checkout to run in, the host it lives on (github.com or
 * an Enterprise host), `owner/name` there, and the key its local copy is kept under.
 */
interface Target {
  cwd: string
  host: string
  repo: string
  key: string
}

/** `249` or `#249`: a number to look up directly rather than search for. */
const asNumber = (q: string): number | null => (/^#?\d+$/.test(q.trim()) ? Number(q.trim().replace('#', '')) : null)

export class IssuesService {
  /** The sync running for each repository, so concurrent searches share one. */
  private readonly syncing = new Map<string, Promise<void>>()
  /** When each repository's count was last checked against GitHub's. */
  private readonly checked = new Map<string, number>()

  constructor(private readonly deps: IssuesDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** The checkout's repository, when `gh` is ready to reach it. */
  private async target(cwd: string): Promise<{ gh: GhStatus; at: Target | null }> {
    const gh = await this.deps.status(cwd)
    const at = gh.state === 'ready' && gh.host && gh.repo ? { cwd, host: gh.host, repo: gh.repo, key: `${gh.host}/${gh.repo}` } : null
    return { gh, at }
  }

  /** `gh api` on the repository's host, as JSON; `lines` reads one JSON value per line (a paginated `--jq '.[]'`). */
  private async api(at: Target, args: string[], { lines = false, timeout }: { lines?: boolean; timeout?: number } = {}): Promise<any> {
    const run = await this.deps.gh(at.cwd, ['api', '--hostname', at.host, ...args], timeout ? { timeout } : undefined)
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

  /**
   * Brings the local copy up to date. Usually a catch-up: only the issues and PRs updated since
   * the last sync — one request when nothing changed, and closing, reopening or reassigning one
   * counts as an update. The first sync, and one asked for with `rebuild`, reads them all and
   * replaces the copy.
   */
  private sync(at: Target, rebuild = false): Promise<void> {
    const running = this.syncing.get(at.key)
    if (running) return running
    const syncedAt = this.deps.cache.syncedAt(at.key)
    const full = rebuild || !syncedAt
    const startedAt = new Date(this.now()).toISOString()
    const since = full ? '' : `&since=${new Date(Date.parse(syncedAt) - SYNC_OVERLAP_MS).toISOString()}`
    const run = this.api(at, ['--paginate', `repos/${at.repo}/issues?state=all&per_page=100&sort=updated&direction=desc${since}`, '--jq', '.[]'], { lines: true, timeout: SYNC_TIMEOUT_MS })
      .then((raw: Raw[]) => this.deps.cache.save(at.key, raw.map(toIssueSummary), { at: startedAt, full }))
      .finally(() => this.syncing.delete(at.key))
    this.syncing.set(at.key, run)
    return run
  }

  /**
   * Waits for the first sync. After that a fresh copy answers at once, and a stale one waits a
   * moment for the catch-up — which brings new issues and PRs as well as changed ones, since a
   * new one's `updated_at` is when it was opened.
   */
  private async current(at: Target): Promise<void> {
    const last = this.deps.cache.syncedAt(at.key)
    if (!last) return this.sync(at)
    if (this.now() - Date.parse(last) <= SYNC_TTL_MS) return
    const catchUp = this.sync(at).catch(() => undefined)
    void catchUp.then(() => this.checkDrift(at))
    await Promise.race([catchUp, new Promise((resolve) => setTimeout(resolve, CATCH_UP_WAIT_MS))])
  }

  /**
   * Behind a catch-up, at most every `DRIFT_CHECK_MS`: GitHub's count of the repository's issues
   * and PRs — one search request — against the copy's. They differ only when something was
   * deleted or transferred away (or the search index is a moment behind), and then the copy is
   * rebuilt.
   */
  private async checkDrift(at: Target): Promise<void> {
    const last = this.checked.get(at.key)
    if (last !== undefined && this.now() - last < DRIFT_CHECK_MS) return
    this.checked.set(at.key, this.now())
    try {
      const found = await this.api(at, ['-X', 'GET', 'search/issues', '-f', `q=repo:${at.repo}`, '-f', 'per_page=1'])
      if (typeof found?.total_count === 'number' && found.total_count !== this.deps.cache.count(at.key)) await this.sync(at, true)
    } catch {
      // A failed check is tried again at the next window; the copy stays as it is.
    }
  }

  async search(cwd: string, q: string, filter: IssueFilter = { kind: 'issue', state: 'open' }, limit = 10): Promise<IssueSearchResponse> {
    const { gh, at } = await this.target(cwd)
    if (!at) return { gh, items: [] }
    await this.current(at)
    // A number the copy does not have yet — opened a moment ago — is asked for directly.
    const number = asNumber(q)
    if (number !== null && !this.deps.cache.summary(at.key, number)) {
      const one = await this.api(at, [`repos/${at.repo}/issues/${number}`]).catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 404) return null
        throw error
      })
      if (one) this.deps.cache.save(at.key, [toIssueSummary(one)])
    }
    return { gh, items: this.deps.cache.search(at.key, q, filter, limit) }
  }

  /** Who `gh` is signed in as on each host, asked once: "Assigned to me" needs it. */
  private readonly viewers = new Map<string, Promise<string | null>>()

  /** Everyone the repository's issues and PRs are assigned to, and who "me" is. */
  async assignees(cwd: string): Promise<IssueAssignees> {
    const { at } = await this.target(cwd)
    if (!at) return { assignees: [], viewer: null }
    await this.current(at)
    if (!this.viewers.has(at.host)) {
      const asked = this.api(at, ['user']).then(
        (user: Raw | null) => login(user),
        () => (this.viewers.delete(at.host), null)
      )
      this.viewers.set(at.host, asked)
    }
    return { assignees: this.deps.cache.assignees(at.key), viewer: await this.viewers.get(at.host)! }
  }

  /** The thread as last read while its issue says nothing changed; read from GitHub otherwise. */
  async read(cwd: string, number: number): Promise<IssueThread> {
    const { gh, at } = await this.target(cwd)
    if (!at) throw new ApiError(409, 'gh_unavailable', `GitHub is not available here (${gh.state})`)
    const { key, repo } = at
    await this.current(at).catch(() => undefined)
    const known = this.deps.cache.summary(key, number)
    const cached = known && this.deps.cache.thread(key, number, known.updatedAt)
    if (cached) return cached
    const [issue, events] = await Promise.all([
      this.api(at, [`repos/${repo}/issues/${number}`]),
      this.api(at, ['--paginate', `repos/${repo}/issues/${number}/timeline`, '--jq', '.[]'], { lines: true })
    ]).catch((error: unknown) => {
      // Deleted on GitHub: the copy stops listing it.
      if (error instanceof ApiError && error.status === 404) this.deps.cache.remove(key, number)
      throw error
    })
    // Transferred: GitHub answers with the issue where it lives now, in another repository.
    const home = movedTo(issue, repo)
    if (home) {
      this.deps.cache.remove(key, number)
      throw new ApiError(410, 'issue_moved', `#${number} was moved to ${home}#${issue.number}`)
    }
    const timeline = (events as Raw[]).map(toTimelineItem).filter((item): item is IssueTimelineItem => item !== null)
    const thread: IssueThread = { ...toIssueSummary(issue), body: String(issue.body ?? ''), createdAt: String(issue.created_at ?? ''), repo, timeline }
    this.deps.cache.save(key, [toIssueSummary(issue)])
    this.deps.cache.saveThread(key, thread)
    return thread
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
