import { z } from 'zod'

import { Ecosystem, Id, Millis } from './common'

export { Ecosystem } from './common'
export type { Ecosystem as EcosystemName } from './common'

export const ComposeInfo = z.object({ file: z.string(), services: z.array(z.string()) })
export type ComposeInfo = z.infer<typeof ComposeInfo>

import { CanopyYamlReport } from './environment'

export const Branch = z.object({
  name: z.string(),
  sha: z.string(),
  /** Committer date, epoch ms. */
  at: Millis,
  current: z.boolean()
})
export type Branch = z.infer<typeof Branch>

/** A branch on a remote, as of the last fetch. `name` drops the remote prefix (`feat/x`, not `origin/feat/x`). */
export const RemoteBranch = z.object({
  name: z.string(),
  sha: z.string(),
  /** Committer date, epoch ms. */
  at: Millis,
  /** A local branch of the same name exists; creating a worktree from this one reuses it. */
  hasLocal: z.boolean()
})
export type RemoteBranch = z.infer<typeof RemoteBranch>

export const RemoteBranchList = z.object({
  /** The remote listed, or null when the repository has no such remote. */
  remote: z.string().nullable(),
  /** Newest first. */
  branches: z.array(RemoteBranch),
  /** Why the fetch failed (offline, auth); the list is then what the last good fetch saw. */
  fetchError: z.string().nullable()
})
export type RemoteBranchList = z.infer<typeof RemoteBranchList>

export const ScanResult = z.object({
  path: z.string(),
  name: z.string(),
  defaultBranch: z.string(),
  branches: z.array(Branch),
  canopyYaml: CanopyYamlReport,
  ecosystems: z.array(Ecosystem),
  compose: ComposeInfo.optional()
})
export type ScanResult = z.infer<typeof ScanResult>

export const Project = z.object({
  id: Id,
  name: z.string(),
  path: z.string(),
  defaultBase: z.string(),
  hasCanopyYaml: z.boolean(),
  /** Lint of the primary checkout's canopy.yaml, re-read when the file changes. */
  config: CanopyYamlReport,
  ecosystems: z.array(Ecosystem),
  compose: ComposeInfo.optional(),
  createdAt: Millis
})
export type Project = z.infer<typeof Project>

export const ScanProjectInput = z.object({ path: z.string().min(1) })
export type ScanProjectInput = z.infer<typeof ScanProjectInput>

export const AddProjectInput = z.object({
  path: z.string().min(1),
  name: z.string().min(1).optional(),
  defaultBase: z.string().min(1).optional()
})
export type AddProjectInput = z.infer<typeof AddProjectInput>

export const UpdateProjectInput = z.object({
  name: z.string().min(1).optional(),
  defaultBase: z.string().min(1).optional()
})
export type UpdateProjectInput = z.infer<typeof UpdateProjectInput>
