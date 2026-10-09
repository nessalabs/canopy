import { z } from 'zod'

import { Millis } from './common'

export const FileStatus = z.enum(['A', 'M', 'D', 'T', 'U'])
export type FileStatus = z.infer<typeof FileStatus>

/**
 * How much of a file is in the index — which is exactly what the commit panel's checkbox shows,
 * because there the checkbox *is* the index rather than a selection kept beside it.
 */
export const StagedState = z.enum(['staged', 'unstaged', 'partial'])
export type StagedState = z.infer<typeof StagedState>

export const ChangedFile = z.object({
  path: z.string(),
  status: FileStatus,
  additions: z.number().int(),
  deletions: z.number().int(),
  binary: z.boolean(),
  staged: StagedState.default('unstaged'),
  /** Unmerged. Note `status: 'U'` means *untracked* here, which is not the same thing. */
  conflicted: z.boolean().default(false),
  /** Blob ids from `status --porcelain=v2`; null when the side has no blob (added/deleted). */
  headSha: z.string().nullable().default(null),
  indexSha: z.string().nullable().default(null)
})
export type ChangedFile = z.infer<typeof ChangedFile>

export const FilePatch = z.object({
  path: z.string(),
  /** Unified diff, or null when binary/truncated. */
  patch: z.string().nullable(),
  truncated: z.boolean(),
  binary: z.boolean()
})
export type FilePatch = z.infer<typeof FilePatch>

export const Commit = z.object({
  sha: z.string(),
  shortSha: z.string(),
  author: z.string(),
  email: z.string(),
  at: Millis,
  subject: z.string(),
  parents: z.array(z.string())
})
export type Commit = z.infer<typeof Commit>

/** What the working tree is compared against in the Changes view. */
export const Against = z.enum(['head', 'base'])
export type Against = z.infer<typeof Against>

/**
 * One description of "which diff" shared by the daemon (git commands) and the UI (hooks).
 * Working-tree diffs and commit diffs are the same feature with a different base.
 */
export const DiffSpec = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('worktree'), against: Against }),
  z.object({ kind: z.literal('commit'), sha: z.string() }),
  /** Two snapshot trees taken around an agent's tool calls (see AgentEdit). */
  z.object({ kind: z.literal('trees'), before: z.string(), after: z.string() })
])
export type DiffSpec = z.infer<typeof DiffSpec>

/** How a path is kept out of the way, and whether that choice is itself committed. */
export const HideMethod = z.enum(['exclude', 'gitignore', 'skipWorktree'])
export type HideMethod = z.infer<typeof HideMethod>

export const HiddenPath = z.object({ path: z.string(), how: HideMethod })
export type HiddenPath = z.infer<typeof HiddenPath>

/**
 * Locally hidden paths. Its own read rather than part of `ChangesResponse` because collecting it
 * costs an `ls-files -v` plus two file reads, and the changes list is polled every few seconds
 * while this changes only when someone hides something.
 */
export const HiddenResponse = z.object({ hidden: z.array(HiddenPath) })
export type HiddenResponse = z.infer<typeof HiddenResponse>

/** A sequence git is in the middle of; staging individual paths during one is unsafe. */
export const GitOperation = z.enum(['merge', 'rebase', 'cherry-pick', 'revert'])
export type GitOperation = z.infer<typeof GitOperation>

export const ChangesResponse = z.object({
  against: Against,
  rev: z.string(),
  baseBranch: z.string(),
  files: z.array(ChangedFile),
  /** Current branch, for the commit button's label; null when detached. */
  branch: z.string().nullable().default(null),
  operation: GitOperation.nullable().default(null)
})
export type ChangesResponse = z.infer<typeof ChangesResponse>

export const LogResponse = z.object({ commits: z.array(Commit), hasMore: z.boolean() })
export type LogResponse = z.infer<typeof LogResponse>

export const TreesResponse = z.object({ before: z.string(), after: z.string(), files: z.array(ChangedFile) })
export type TreesResponse = z.infer<typeof TreesResponse>

export const CommitResponse = z.object({ commit: Commit, files: z.array(ChangedFile) })
export type CommitResponse = z.infer<typeof CommitResponse>

/** One entry of a directory listing in the worktree browser. */
export const TreeEntry = z.object({ name: z.string(), path: z.string(), kind: z.enum(['dir', 'file']) })
export type TreeEntry = z.infer<typeof TreeEntry>

export const TreeResponse = z.object({ path: z.string(), entries: z.array(TreeEntry) })
export type TreeResponse = z.infer<typeof TreeResponse>

/** A file's text, or null when binary/over the size cap (mirrors FilePatch). */
export const FileContents = z.object({
  path: z.string(),
  content: z.string().nullable(),
  truncated: z.boolean(),
  binary: z.boolean(),
  size: z.number().int()
})
export type FileContents = z.infer<typeof FileContents>

// =====================================================================================
// Commit panel — staging is the index, so every input below names paths, not a selection
// =====================================================================================

/** One batched round of checkbox toggles. Both lists may be non-empty. */
export const StageInput = z.object({
  stage: z.array(z.string()).default([]),
  unstage: z.array(z.string()).default([])
})
export type StageInput = z.infer<typeof StageInput>

/**
 * Replaces what is staged for one file with exactly `hunks` of its HEAD→worktree patch.
 * `patchHash` is the hash of the patch the picks were made against; a mismatch means the file
 * changed underneath and the request is refused rather than staging the wrong lines.
 */
export const StageHunksInput = z.object({
  path: z.string().min(1),
  hunks: z.array(z.number().int().min(0)),
  patchHash: z.string().min(1)
})
export type StageHunksInput = z.infer<typeof StageHunksInput>

/** Which hunks of a file's HEAD→worktree patch are currently in the index. */
export const HunkStatesResponse = z.object({
  path: z.string(),
  patchHash: z.string(),
  /** Hunks every one of whose changes is in the index. */
  staged: z.array(z.number().int()),
  /** Hunks only some of whose changes are in the index — the box shows mixed. */
  partial: z.array(z.number().int()),
  /**
   * False when the index holds content for this file that these hunks cannot express — staged
   * from a terminal some other way, or the same line staged as one thing and edited to another.
   * Rebuilding the entry from HEAD would then throw that work away, so the UI says so and offers
   * whole-file staging instead of boxes that lie.
   */
  representable: z.boolean()
})
export type HunkStatesResponse = z.infer<typeof HunkStatesResponse>

export const CommitInput = z.object({
  summary: z.string().min(1).max(1024),
  description: z.string().optional(),
  /** Skip pre-commit/commit-msg hooks. */
  noVerify: z.boolean().default(false)
})
export type CommitInput = z.infer<typeof CommitInput>

/** What Claude is asked to draft: a message for the staged changes, or a PR for the branch into `base`. */
export const DraftInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('commit') }),
  z.object({ kind: z.literal('pullRequest'), base: z.string().min(1) })
])
export type DraftInput = z.infer<typeof DraftInput>
export type DraftKind = DraftInput['kind']

/** A title (commit summary or PR title) and body Claude drafted, for the user to edit before using. */
export const TextDraft = z.object({ title: z.string(), body: z.string() })
export type TextDraft = z.infer<typeof TextDraft>

/**
 * `exclude` writes `.git/info/exclude` (local, never committed, shared by the project's
 * worktrees), `gitignore` writes `.gitignore` (committed), `skipWorktree` hides local edits to a
 * tracked file (local, this worktree only), `untrack` is `git rm --cached` — a real repo change
 * that shows up as a staged deletion and takes effect on the next commit.
 */
export const ExcludeMethod = z.enum(['exclude', 'gitignore', 'skipWorktree', 'untrack'])
export type ExcludeMethod = z.infer<typeof ExcludeMethod>

export const ExcludeInput = z.object({ paths: z.array(z.string().min(1)).min(1), how: ExcludeMethod })
export type ExcludeInput = z.infer<typeof ExcludeInput>

export const UnhideInput = z.object({ paths: z.array(z.string().min(1)).min(1) })
export type UnhideInput = z.infer<typeof UnhideInput>

/**
 * How a worktree's branch lands on its base. `merge` keeps the commits under a merge commit,
 * `squash` folds them into one commit with `message`, `ff` only moves the base pointer and
 * refuses when the branch is behind.
 */
export const MergeStrategy = z.enum(['merge', 'squash', 'ff'])
export type MergeStrategy = z.infer<typeof MergeStrategy>

export const MergeInput = z.object({
  strategy: MergeStrategy.default('merge'),
  /** The merge or squash commit's message; a merge without one gets git's default. */
  message: z.string().max(8192).optional()
})
export type MergeInput = z.infer<typeof MergeInput>

export const MergeResult = z.object({
  /** The base branch's new tip. */
  sha: z.string(),
  into: z.string(),
  strategy: MergeStrategy,
  /** Where the base branch was checked out and the merge ran; null for a pointer-only fast-forward. */
  checkout: z.string().nullable()
})
export type MergeResult = z.infer<typeof MergeResult>
