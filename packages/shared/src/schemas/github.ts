import { z } from 'zod'

import { Commit } from './git'

/**
 * Whether the daemon can talk to GitHub for this worktree. Everything goes through the GitHub
 * CLI (`gh`) on the daemon's machine, with its login, so each state that is not `ready` is
 * something a person does there: install it, sign in, or accept that the remote is elsewhere.
 */
export const GhState = z.enum(['ready', 'missing', 'unauthenticated', 'no-remote', 'not-github'])
export type GhState = z.infer<typeof GhState>

export const GhStatus = z.object({
  state: GhState,
  /** The remote's host (github.com, or an Enterprise host), when there is a remote. */
  host: z.string().nullable(),
  /** `owner/name` read from the remote URL. */
  repo: z.string().nullable(),
  /** The remote's URL, so a non-GitHub remote can be named in the explanation. */
  remoteUrl: z.string().nullable(),
  /** What `gh` said when it refused; shown under the setup steps. */
  detail: z.string().nullable()
})
export type GhStatus = z.infer<typeof GhStatus>

export const PullRequestState = z.enum(['OPEN', 'CLOSED', 'MERGED'])
export type PullRequestState = z.infer<typeof PullRequestState>

/** One CI result, whether GitHub reported it as a check run or as a commit status. */
export const PullRequestCheck = z.object({
  name: z.string(),
  /** The workflow a check run belongs to; null for commit statuses. */
  workflow: z.string().nullable(),
  outcome: z.enum(['pass', 'fail', 'pending', 'skipped', 'neutral']),
  url: z.string().nullable()
})
export type PullRequestCheck = z.infer<typeof PullRequestCheck>

/** A review verdict or a conversation comment; the tab shows them as one timeline. */
export const PullRequestEvent = z.object({
  kind: z.enum(['review', 'comment']),
  author: z.string(),
  body: z.string(),
  /** Review verdict (APPROVED, CHANGES_REQUESTED, COMMENTED, …); null for comments. */
  verdict: z.string().nullable(),
  at: z.string()
})
export type PullRequestEvent = z.infer<typeof PullRequestEvent>

/** Someone asked to review, and where their review stands. */
export const PullRequestReviewer = z.object({
  /** A user's login, or a team's slug. */
  name: z.string(),
  team: z.boolean(),
  /** `requested` while their review is pending; otherwise their latest verdict. */
  state: z.enum(['requested', 'APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING'])
})
export type PullRequestReviewer = z.infer<typeof PullRequestReviewer>

export const MergeMethod = z.enum(['merge', 'squash', 'rebase'])
export type MergeMethod = z.infer<typeof MergeMethod>

export const PullRequest = z.object({
  number: z.number().int(),
  title: z.string(),
  body: z.string(),
  url: z.string(),
  state: PullRequestState,
  draft: z.boolean(),
  author: z.string(),
  baseBranch: z.string(),
  headBranch: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  mergedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  additions: z.number().int(),
  deletions: z.number().int(),
  changedFiles: z.number().int(),
  commits: z.number().int(),
  /**
   * The PR's commits as GitHub has them, oldest first. `parents` is empty (gh does not report
   * them); a commit this checkout has not fetched has no diff to show until it is pulled.
   */
  commitLog: z.array(Commit),
  /** Shas in `commitLog` this checkout does not have; their diffs need a fetch first. */
  missingCommits: z.array(z.string()),
  assignees: z.array(z.object({ login: z.string(), name: z.string().nullable() })),
  reviewers: z.array(PullRequestReviewer),
  labels: z.array(z.object({ name: z.string(), color: z.string() })),
  milestone: z.string().nullable(),
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or null when the repo requires no review. */
  reviewDecision: z.string().nullable(),
  /** MERGEABLE, CONFLICTING or UNKNOWN (GitHub computes it lazily). */
  mergeable: z.string(),
  /**
   * GitHub's verdict on merging now: CLEAN, BLOCKED (reviews or required checks), BEHIND,
   * DIRTY (conflicts), UNSTABLE (non-required checks failing), DRAFT, HAS_HOOKS or UNKNOWN.
   */
  mergeState: z.string(),
  /** Auto-merge is on: GitHub merges once requirements pass. */
  autoMerge: z.boolean(),
  headSha: z.string(),
  /**
   * The PR's whole change as two commits to diff — the merge base with its target, and its
   * head — or null when this checkout lacks the head or the target branch.
   */
  filesRange: z.object({ before: z.string(), after: z.string() }).nullable(),
  checks: z.array(PullRequestCheck),
  events: z.array(PullRequestEvent)
})
export type PullRequest = z.infer<typeof PullRequest>

/**
 * A PR as the Command Center's worktree list shows it: enough to say at a glance whether a
 * branch has one and where it stands, without the pane's timeline, commits or diff range.
 */
export const PullRequestSummary = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: PullRequestState,
  draft: z.boolean(),
  headBranch: z.string(),
  baseBranch: z.string(),
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or null when the repo requires no review. */
  reviewDecision: z.string().nullable(),
  /** All checks folded into one: any failure fails, else any pending is pending; null with no checks. */
  checks: z.enum(['pass', 'fail', 'pending']).nullable(),
  updatedAt: z.string()
})
export type PullRequestSummary = z.infer<typeof PullRequestSummary>

/** Every recent PR of a project's repository, newest first, one per head branch. */
export const ProjectPullRequests = z.object({
  gh: GhStatus,
  prs: z.array(PullRequestSummary)
})
export type ProjectPullRequests = z.infer<typeof ProjectPullRequests>

/** Where the local branch stands against the branch it pushes to. */
export const UpstreamStatus = z.object({
  /** e.g. `origin/feat/x`; null when the branch has never been pushed. */
  name: z.string().nullable(),
  /** Local commits the remote lacks; null without an upstream. */
  ahead: z.number().int().nullable(),
  behind: z.number().int().nullable()
})
export type UpstreamStatus = z.infer<typeof UpstreamStatus>

export const PullRequestResponse = z.object({
  gh: GhStatus,
  /** The worktree's branch; null when detached, which has nothing to open a PR from. */
  branch: z.string().nullable(),
  baseBranch: z.string(),
  upstream: UpstreamStatus.nullable(),
  /** The newest PR whose head is this branch, open or not; null when there is none. */
  pr: PullRequest.nullable(),
  /** Who `gh` is signed in as; GitHub will not let the author approve their own PR. */
  viewer: z.string().nullable(),
  /** Merge methods the repository allows, in GitHub's order of preference. */
  mergeMethods: z.array(MergeMethod),
  /** Whether the viewer may merge here at all (write access or more). */
  canMerge: z.boolean(),
  /** Title and body suggested for a new PR, from the branch's commits. */
  draft: z.object({ title: z.string(), body: z.string() }).nullable(),
  /**
   * Branches a new PR can target: the remote's, as of the last fetch, without this branch.
   * Empty when a PR already exists — only the create form asks.
   */
  bases: z.array(z.string()),
  /**
   * The target the form starts on: the branch this worktree was cut from when the remote has
   * it, else the remote's default branch.
   */
  suggestedBase: z.string().nullable()
})
export type PullRequestResponse = z.infer<typeof PullRequestResponse>

export const CreatePullRequestInput = z.object({
  title: z.string().trim().min(1),
  body: z.string().default(''),
  base: z.string().min(1).optional(),
  draft: z.boolean().default(false)
})
export type CreatePullRequestInput = z.input<typeof CreatePullRequestInput>

/** Everything the PR pane can do to the PR itself, as one request with a `kind`. */
export const PullRequestAction = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('merge'),
    method: MergeMethod,
    /** Delete the branch on GitHub once merged. The local branch and worktree are left alone. */
    deleteBranch: z.boolean().default(false),
    /** Turn on auto-merge instead of merging now, for a PR still waiting on checks or reviews. */
    auto: z.boolean().default(false),
    subject: z.string().optional(),
    body: z.string().optional()
  }),
  z.object({
    kind: z.literal('review'),
    event: z.enum(['approve', 'request-changes', 'comment']),
    body: z.string().default(''),
    /** Local line comments to post with the review as inline comments on the PR's diff. */
    commentIds: z.array(z.string()).default([])
  }),
  z.object({ kind: z.literal('comment'), body: z.string().trim().min(1) }),
  z.object({ kind: z.literal('ready'), ready: z.boolean() }),
  z.object({ kind: z.literal('close') }),
  z.object({ kind: z.literal('reopen') }),
  /** Re-runs the failed jobs of every GitHub Actions run with a failing check. */
  z.object({ kind: z.literal('rerun') }),
  /** Request or withdraw reviews; a team is `org/slug`. */
  z.object({ kind: z.literal('reviewers'), add: z.array(z.string()).default([]), remove: z.array(z.string()).default([]) }),
  z.object({ kind: z.literal('assignees'), add: z.array(z.string()).default([]), remove: z.array(z.string()).default([]) }),
  z.object({ kind: z.literal('labels'), add: z.array(z.string()).default([]), remove: z.array(z.string()).default([]) }),
  /** null clears the milestone. */
  z.object({ kind: z.literal('milestone'), milestone: z.string().nullable() })
])
export type PullRequestAction = z.input<typeof PullRequestAction>

export const PullRequestActionResult = z.object({ message: z.string() })
export type PullRequestActionResult = z.infer<typeof PullRequestActionResult>

/** One reply in a GitHub review thread. */
export const GitHubThreadComment = z.object({
  id: z.string(),
  author: z.string(),
  body: z.string(),
  at: z.string(),
  url: z.string()
})
export type GitHubThreadComment = z.infer<typeof GitHubThreadComment>

/** An inline review thread on the PR's diff, as GitHub keeps it. */
export const GitHubThread = z.object({
  id: z.string(),
  file: z.string(),
  /** The line in the PR's current diff; null once the code moved on (outdated). */
  line: z.number().int().nullable(),
  /** Where it was left originally, for an outdated thread. */
  originalLine: z.number().int().nullable(),
  side: z.enum(['old', 'new']),
  resolved: z.boolean(),
  outdated: z.boolean(),
  comments: z.array(GitHubThreadComment)
})
export type GitHubThread = z.infer<typeof GitHubThread>

export const PullRequestThreadsResponse = z.object({ number: z.number().int(), threads: z.array(GitHubThread) })
export type PullRequestThreadsResponse = z.infer<typeof PullRequestThreadsResponse>

/** What the repository offers for the PR's sidebar: people to ask, labels, open milestones. */
export const PullRequestOptions = z.object({
  users: z.array(z.object({ login: z.string(), name: z.string().nullable() })),
  labels: z.array(z.object({ name: z.string(), color: z.string() })),
  milestones: z.array(z.string())
})
export type PullRequestOptions = z.infer<typeof PullRequestOptions>

export const PushResult = z.object({ upstream: UpstreamStatus })
export type PushResult = z.infer<typeof PushResult>
