import type { DiffSpec, SessionRef } from '@canopy/shared'

/** Every cache key in one place so mutations invalidate the right reads. */
export const keys = {
  projects: ['projects'] as const,
  branches: (projectId: string) => ['branches', projectId] as const,
  worktrees: ['worktrees'] as const,
  worktree: (id: string) => ['worktree', id] as const,
  diffFiles: (worktreeId: string, spec: DiffSpec) => ['diff-files', worktreeId, spec] as const,
  filePatch: (worktreeId: string, spec: DiffSpec, path: string) => ['file-patch', worktreeId, spec, path] as const,
  tree: (worktreeId: string, dir: string) => ['tree', worktreeId, dir] as const,
  fileContents: (worktreeId: string, path: string, rev?: string) => ['file', worktreeId, rev ?? 'worktree', path] as const,
  log: (worktreeId: string) => ['log', worktreeId] as const,
  comments: (worktreeId: string) => ['comments', worktreeId] as const,
  sessions: (worktreeId: string) => ['agent-sessions', worktreeId] as const,
  transcript: (ref: SessionRef) => ['transcript', ref.provider, ref.sessionId] as const,
  edits: (ref: SessionRef) => ['agent-edits', ref.provider, ref.sessionId] as const,
  providers: ['providers'] as const,
  // ---- environment & resources ----
  host: ['host'] as const,
  appSettings: ['app-settings'] as const,
  projectSettings: (projectId: string) => ['project-settings', projectId] as const,
  projectConfig: (projectId: string) => ['project-config', projectId] as const,
  projectEnvironment: (projectId: string) => ['project-environment', projectId] as const,
  projectWtToml: (projectId: string) => ['project-wt-toml', projectId] as const,
  resources: (worktreeId: string) => ['resources', worktreeId] as const,
  logs: (worktreeId: string, service: string) => ['logs', worktreeId, service] as const,
  dirs: (path: string | undefined, hidden: boolean) => ['fs-dirs', path ?? '~', hidden] as const
}
