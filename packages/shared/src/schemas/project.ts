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
