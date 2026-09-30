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
  checks: z.array(PullRequestCheck),
  events: z.array(PullRequestEvent)
})
export type PullRequest = z.infer<typeof PullRequest>

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

export const PushResult = z.object({ upstream: UpstreamStatus })
export type PushResult = z.infer<typeof PushResult>
