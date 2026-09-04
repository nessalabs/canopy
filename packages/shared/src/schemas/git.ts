import { z } from 'zod'

import { Millis } from './common'

export const FileStatus = z.enum(['A', 'M', 'D', 'T', 'U'])
export type FileStatus = z.infer<typeof FileStatus>

export const ChangedFile = z.object({
  path: z.string(),
  status: FileStatus,
  additions: z.number().int(),
  deletions: z.number().int(),
  binary: z.boolean()
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

export const ChangesResponse = z.object({
  against: Against,
  rev: z.string(),
  baseBranch: z.string(),
  files: z.array(ChangedFile)
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
