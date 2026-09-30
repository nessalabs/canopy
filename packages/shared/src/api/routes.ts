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
  projectTrash: (id: string) => `${API_PREFIX}/projects/${id}/trash`,
  trashEntry: (id: string, entry: string) => `${API_PREFIX}/projects/${id}/trash/${entry}`,
  trashRestore: (id: string, entry: string) => `${API_PREFIX}/projects/${id}/trash/${entry}/restore`,
  worktrees: () => `${API_PREFIX}/worktrees`,
  worktree: (id: string) => `${API_PREFIX}/worktrees/${id}`,
  changes: (id: string) => `${API_PREFIX}/worktrees/${id}/changes`,
  changesFile: (id: string) => `${API_PREFIX}/worktrees/${id}/changes/file`,
  tree: (id: string) => `${API_PREFIX}/worktrees/${id}/tree`,
  /** Every file in the worktree, flat — what the open-anything picker searches. */
  files: (id: string) => `${API_PREFIX}/worktrees/${id}/files`,
  file: (id: string) => `${API_PREFIX}/worktrees/${id}/file`,
  log: (id: string) => `${API_PREFIX}/worktrees/${id}/log`,
  commit: (id: string, sha: string) => `${API_PREFIX}/worktrees/${id}/commits/${sha}`,
  commitFile: (id: string, sha: string) => `${API_PREFIX}/worktrees/${id}/commits/${sha}/file`,
  trees: (id: string, before: string, after: string) => `${API_PREFIX}/worktrees/${id}/trees/${before}/${after}`,
  treesFile: (id: string, before: string, after: string) => `${API_PREFIX}/worktrees/${id}/trees/${before}/${after}/file`,
  /** Batched checkbox toggles: stage/unstage paths. Answers with the fresh changes list. */
  stage: (id: string) => `${API_PREFIX}/worktrees/${id}/stage`,
  /** Replace what is staged for one file with a chosen set of its hunks; GET reports the set. */
  stageHunks: (id: string) => `${API_PREFIX}/worktrees/${id}/stage/hunks`,
  commitChanges: (id: string) => `${API_PREFIX}/worktrees/${id}/commit`,
  /** Land the worktree's branch on its base branch. */
  merge: (id: string) => `${API_PREFIX}/worktrees/${id}/merge`,
  /** Keep a path out of commits: .git/info/exclude, .gitignore, skip-worktree or rm --cached. */
  exclude: (id: string) => `${API_PREFIX}/worktrees/${id}/exclude`,
  unhide: (id: string) => `${API_PREFIX}/worktrees/${id}/unhide`,
  /** The branch's GitHub pull request through `gh`: GET reads it (or why it cannot), POST opens one. */
  pullRequest: (id: string) => `${API_PREFIX}/worktrees/${id}/pull-request`,
  /** `git push` of the worktree's branch to its upstream, setting one on the first push. */
  /** Fetches the PR's head (`refs/pull/N/head`) so commits pushed from elsewhere have diffs here. */
  /** Acts on the branch's PR through `gh`: merge, review, comment, ready, close, reopen, rerun. */
  pullRequestAction: (id: string) => `${API_PREFIX}/worktrees/${id}/pull-request/actions`,
  pullRequestFetch: (id: string) => `${API_PREFIX}/worktrees/${id}/pull-request/fetch`,
  push: (id: string) => `${API_PREFIX}/worktrees/${id}/push`,
  /** Locally hidden paths; read on its own because the changes poll must not pay for it. */
  hidden: (id: string) => `${API_PREFIX}/worktrees/${id}/hidden`,
  comments: (id: string) => `${API_PREFIX}/worktrees/${id}/comments`,
  comment: (id: string, cid: string) => `${API_PREFIX}/worktrees/${id}/comments/${cid}`,
  review: (id: string) => `${API_PREFIX}/worktrees/${id}/review`,
  agentSessions: (id: string) => `${API_PREFIX}/worktrees/${id}/agent/sessions`,
  agentPin: (id: string) => `${API_PREFIX}/worktrees/${id}/agent/pin`,
  providers: () => `${API_PREFIX}/agents/providers`,
  transcript: (provider: string, sid: string) => `${API_PREFIX}/agent/sessions/${provider}/${sid}/transcript`,
  messages: (provider: string, sid: string) => `${API_PREFIX}/agent/sessions/${provider}/${sid}/messages`,
  agentEdits: (provider: string, sid: string) => `${API_PREFIX}/agent/sessions/${provider}/${sid}/edits`,
  /** Answers a `permission_requested` event of a turn running in this session. */
  permissions: (provider: string, sid: string) => `${API_PREFIX}/agent/sessions/${provider}/${sid}/permissions`,
  /** What a session in this worktree can do: commands, skills, subagents, models, MCP servers, hooks. */
  agentCapabilities: (id: string) => `${API_PREFIX}/worktrees/${id}/agent/capabilities`,
  /** Stops the turn running in this session the way Esc does in a terminal; the stream then ends normally. */
  interrupt: (provider: string, sid: string) => `${API_PREFIX}/agent/sessions/${provider}/${sid}/interrupt`,
  /** Hands a prompt to the running turn, the way typing while the agent works does in a terminal. */
  queue: (provider: string, sid: string) => `${API_PREFIX}/agent/sessions/${provider}/${sid}/queue`,
  /** Restores the worktree's files to how they were before one of this session's user messages. */
  rewind: (provider: string, sid: string) => `${API_PREFIX}/agent/sessions/${provider}/${sid}/rewind`,
  /** Changes the model or access mode of the running turn for its next model call. */
  liveControls: (provider: string, sid: string) => `${API_PREFIX}/agent/sessions/${provider}/${sid}/controls`,
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
