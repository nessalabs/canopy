export const API_PREFIX = '/api/v1'

/** Ids are UUIDs, shas, or provider names — URL-safe by construction, so paths double as Fastify route templates. */

/** Every daemon route in one place, so the client and the server never drift. */
export const routes = {
  healthz: () => '/healthz',
  projects: () => `${API_PREFIX}/projects`,
  scanProject: () => `${API_PREFIX}/projects/scan`,
  project: (id: string) => `${API_PREFIX}/projects/${id}`,
  branches: (id: string) => `${API_PREFIX}/projects/${id}/branches`,
  projectWorktrees: (id: string) => `${API_PREFIX}/projects/${id}/worktrees`,
  worktrees: () => `${API_PREFIX}/worktrees`,
  worktree: (id: string) => `${API_PREFIX}/worktrees/${id}`,
  changes: (id: string) => `${API_PREFIX}/worktrees/${id}/changes`,
  changesFile: (id: string) => `${API_PREFIX}/worktrees/${id}/changes/file`,
  tree: (id: string) => `${API_PREFIX}/worktrees/${id}/tree`,
  file: (id: string) => `${API_PREFIX}/worktrees/${id}/file`,
  log: (id: string) => `${API_PREFIX}/worktrees/${id}/log`,
  commit: (id: string, sha: string) => `${API_PREFIX}/worktrees/${id}/commits/${sha}`,
  commitFile: (id: string, sha: string) => `${API_PREFIX}/worktrees/${id}/commits/${sha}/file`,
  trees: (id: string, before: string, after: string) => `${API_PREFIX}/worktrees/${id}/trees/${before}/${after}`,
  treesFile: (id: string, before: string, after: string) => `${API_PREFIX}/worktrees/${id}/trees/${before}/${after}/file`,
  comments: (id: string) => `${API_PREFIX}/worktrees/${id}/comments`,
  comment: (id: string, cid: string) => `${API_PREFIX}/worktrees/${id}/comments/${cid}`,
  review: (id: string) => `${API_PREFIX}/worktrees/${id}/review`,
  agentSessions: (id: string) => `${API_PREFIX}/worktrees/${id}/agent/sessions`,
  agentPin: (id: string) => `${API_PREFIX}/worktrees/${id}/agent/pin`,
  providers: () => `${API_PREFIX}/agents/providers`,
  transcript: (provider: string, sid: string) => `${API_PREFIX}/agent/sessions/${provider}/${sid}/transcript`,
  messages: (provider: string, sid: string) => `${API_PREFIX}/agent/sessions/${provider}/${sid}/messages`,
  agentEdits: (provider: string, sid: string) => `${API_PREFIX}/agent/sessions/${provider}/${sid}/edits`,
  /** Claude Code PreToolUse/PostToolUse hook receiver (see bin/canopy-hook.mjs). */
  hooksClaude: () => `${API_PREFIX}/hooks/claude`
} as const
