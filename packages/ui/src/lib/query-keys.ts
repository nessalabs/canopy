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
  worktreeFiles: (worktreeId: string) => ['worktree-files', worktreeId] as const,
  fileContents: (worktreeId: string, path: string, rev?: string) => ['file', worktreeId, rev ?? 'worktree', path] as const,
  log: (worktreeId: string) => ['log', worktreeId] as const,
  comments: (worktreeId: string) => ['comments', worktreeId] as const,
  /** Which hunks of one file are in the index; only read while that file's hunk view is open. */
  hunkStates: (worktreeId: string, path: string) => ['hunk-states', worktreeId, path] as const,
  hidden: (worktreeId: string) => ['hidden', worktreeId] as const,
  /** The branch's GitHub PR (or why there is none to show), read through the daemon's `gh`. */
  pullRequest: (worktreeId: string) => ['pull-request', worktreeId] as const,
  /** The repository's assignable users, labels and milestones, read when a sidebar picker opens. */
  pullRequestOptions: (worktreeId: string) => ['pull-request-options', worktreeId] as const,
  sessions: (worktreeId: string) => ['agent-sessions', worktreeId] as const,
  transcript: (ref: SessionRef) => ['transcript', ref.provider, ref.sessionId] as const,
  edits: (ref: SessionRef) => ['agent-edits', ref.provider, ref.sessionId] as const,
  /** What a provider advertises for this checkout: commands, skills, subagents, models, hooks. */
  capabilities: (worktreeId: string, provider: string, sessionId?: string) => ['agent-capabilities', worktreeId, provider, sessionId ?? 'checkout'] as const,
  /** Every capability read of one worktree — the prefix a finished turn invalidates. */
  capabilitiesOf: (worktreeId: string) => ['agent-capabilities', worktreeId] as const,
  providers: ['providers'] as const,
  // ---- environment & resources ----
  host: ['host'] as const,
  appSettings: ['app-settings'] as const,
  projectSettings: (projectId: string) => ['project-settings', projectId] as const,
  projectConfig: (projectId: string) => ['project-config', projectId] as const,
  projectTrash: (projectId: string) => ['project-trash', projectId] as const,
  projectEnvironment: (projectId: string) => ['project-environment', projectId] as const,
  resources: (worktreeId: string) => ['resources', worktreeId] as const,
  logs: (worktreeId: string, service: string) => ['logs', worktreeId, service] as const,
  dirs: (path: string | undefined, hidden: boolean) => ['fs-dirs', path ?? '~', hidden] as const
}
