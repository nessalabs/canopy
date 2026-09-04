import { z } from 'zod'

import { Id, Millis } from './common'

export const Ecosystem = z.enum(['node', 'python', 'go', 'rust', 'docker-compose'])
export type Ecosystem = z.infer<typeof Ecosystem>

export const ComposeInfo = z.object({ file: z.string(), services: z.array(z.string()) })
export type ComposeInfo = z.infer<typeof ComposeInfo>

/** The subset of canopy.yaml this iteration validates; unknown keys are kept. */
export const CanopyYaml = z.looseObject({
  version: z.literal(1),
  name: z.string().optional()
})
export type CanopyYaml = z.infer<typeof CanopyYaml>

export const CanopyYamlReport = z.object({
  present: z.boolean(),
  valid: z.boolean(),
  errors: z.array(z.string())
})
export type CanopyYamlReport = z.infer<typeof CanopyYamlReport>

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
