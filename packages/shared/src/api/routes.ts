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
  hooksClaude: () => `${API_PREFIX}/hooks/claude`,

  // ---- environment & resources ----
  host: () => `${API_PREFIX}/host`,
  /** Subdirectories of a path on the daemon's machine (`?path=&hidden=1`), for picking a repo folder. */
  fsDirs: () => `${API_PREFIX}/fs/dirs`,
  /** SSE multiplex of environment/resources/host events; `?since=<seq>` resumes. */
  events: () => `${API_PREFIX}/events`,
  appSettings: () => `${API_PREFIX}/settings`,
  projectSettings: (id: string) => `${API_PREFIX}/projects/${id}/settings`,
  /** The primary checkout's canopy.yaml: GET raw+report, PUT raw. */
  projectConfig: (id: string) => `${API_PREFIX}/projects/${id}/config`,
  projectConfigScaffold: (id: string) => `${API_PREFIX}/projects/${id}/config/scaffold`,
  /** Resolved preview (services, ports, databases, detected caches/copy candidates). */
  projectEnvironment: (id: string) => `${API_PREFIX}/projects/${id}/environment`,
  projectWtToml: (id: string) => `${API_PREFIX}/projects/${id}/wt-toml`,
  projectDbRefresh: (id: string, db: string) => `${API_PREFIX}/projects/${id}/databases/${db}/refresh`,
  projectStopAll: (id: string) => `${API_PREFIX}/projects/${id}/stop`,
  projectDestroyAll: (id: string) => `${API_PREFIX}/projects/${id}/destroy-worktrees`,
  adoptWorktree: () => `${API_PREFIX}/worktrees/adopt`,
  worktreeEnvironment: (id: string) => `${API_PREFIX}/worktrees/${id}/environment`,
  worktreeStart: (id: string) => `${API_PREFIX}/worktrees/${id}/start`,
  worktreeStop: (id: string) => `${API_PREFIX}/worktrees/${id}/stop`,
  worktreeRestart: (id: string) => `${API_PREFIX}/worktrees/${id}/restart`,
  worktreeProvision: (id: string) => `${API_PREFIX}/worktrees/${id}/provision`,
  /** Stops services, drops forks, frees ports and forgets the environment, keeping the checkout. */
  worktreeTeardown: (id: string) => `${API_PREFIX}/worktrees/${id}/teardown`,
  worktreeEnvFile: (id: string) => `${API_PREFIX}/worktrees/${id}/env-file`,
  worktreeOpen: (id: string) => `${API_PREFIX}/worktrees/${id}/open`,
  worktreeResources: (id: string) => `${API_PREFIX}/worktrees/${id}/resources`,
  serviceAction: (id: string, name: string, action: string) => `${API_PREFIX}/worktrees/${id}/services/${name}/${action}`,
  /** Backfill by `?since=<offset>&limit=`; `&follow=1` switches to SSE. */
  serviceLogs: (id: string, name: string) => `${API_PREFIX}/worktrees/${id}/services/${name}/logs`,
  databaseReset: (id: string, name: string) => `${API_PREFIX}/worktrees/${id}/databases/${name}/reset`
} as const
