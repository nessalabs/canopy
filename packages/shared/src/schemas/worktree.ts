import { z } from 'zod'

import { Id, Millis } from './common'
import { WorktreeEnvironment, WorktreeOptions } from './environment'

export const LastCommit = z.object({
  sha: z.string(),
  shortSha: z.string(),
  author: z.string(),
  email: z.string(),
  at: Millis,
  subject: z.string()
})
export type LastCommit = z.infer<typeof LastCommit>

export const WorktreeStatus = z.object({
  head: z.string(),
  ahead: z.number().int().nullable(),
  behind: z.number().int().nullable(),
  staged: z.number().int(),
  unstaged: z.number().int(),
  untracked: z.number().int(),
  conflicted: z.number().int(),
  dirtyTotal: z.number().int(),
  lastCommit: LastCommit.nullable()
})
export type WorktreeStatus = z.infer<typeof WorktreeStatus>

export const WorktreeState = z.enum(['clean', 'dirty', 'detached', 'missing'])
export type WorktreeState = z.infer<typeof WorktreeState>

export const Worktree = z.object({
  id: Id,
  projectId: Id,
  name: z.string(),
  path: z.string(),
  branch: z.string().nullable(),
  baseBranch: z.string(),
  isMain: z.boolean(),
  /** Created by Canopy (as opposed to discovered from `git worktree list`). */
  managed: z.boolean(),
  state: WorktreeState,
  status: WorktreeStatus.nullable(),
  /** Services, databases, ports, env and provisioning for this worktree. */
  environment: WorktreeEnvironment
})
export type Worktree = z.infer<typeof Worktree>

export const WORKTREE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/

export const BranchSpec = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('new'), name: z.string().min(1), base: z.string().min(1) }),
  z.object({ mode: z.literal('existing'), name: z.string().min(1) })
])
export type BranchSpec = z.infer<typeof BranchSpec>

export const CreateWorktreeInput = z.object({
  name: z.string().regex(WORKTREE_NAME_PATTERN, 'lowercase letters, digits, . _ - only'),
  branch: BranchSpec,
  /** Provision (ports, databases, env, setup) right after creation when the project has a canopy.yaml. Default true. */
  provision: z.boolean().optional(),
  /** Start services once provisioned. Defaults to the project's `defaults.autoStart`. */
  autoStart: z.boolean().optional(),
  options: WorktreeOptions.partial().optional()
})
export type CreateWorktreeInput = z.infer<typeof CreateWorktreeInput>
