/**
 * Pure helpers over the environment schemas, shared by the daemon and the UI: defaults,
 * template rendering, rollups. No I/O.
 */
import {
  DEFAULT_WORKTREE_OPTIONS,
  type AppSettings,
  type CacheRule,
  type DraftSettings,
  type EnvState,
  type ProjectSettings,
  type ProjectSettingsPatch,
  type ServiceInfo,
  type ServiceStatus,
  type WorktreeEnvironment,
  type WorktreeOptions
} from './schemas/environment'
import type { Ecosystem } from './schemas/common'

// ---------- defaults ----------

export const DEFAULT_PORT_RANGE: [number, number] = [40000, 44999]

/** Cache directories per ecosystem, in the order they are offered. */
export const ECOSYSTEM_CACHES: Record<Ecosystem, Array<{ path: string; strategy: CacheRule['strategy'] }>> = {
  node: [
    { path: 'node_modules', strategy: 'clone' },
    { path: '*/node_modules', strategy: 'clone' },
    { path: '*/*/node_modules', strategy: 'clone' },
    { path: '.next', strategy: 'fresh' },
    { path: '.turbo', strategy: 'fresh' },
    { path: '.vite', strategy: 'fresh' },
    { path: '.parcel-cache', strategy: 'fresh' },
    { path: 'dist', strategy: 'fresh' }
  ],
  python: [
    { path: '.venv', strategy: 'clone' },
    { path: '__pycache__', strategy: 'fresh' },
    { path: '.pytest_cache', strategy: 'fresh' },
    { path: '.mypy_cache', strategy: 'fresh' },
    { path: '.ruff_cache', strategy: 'fresh' }
  ],
  rust: [{ path: 'target', strategy: 'clone' }],
  go: [{ path: 'vendor', strategy: 'clone' }],
  'docker-compose': []
}

/** Lockfiles whose change means "the cloned dependencies may be stale", per ecosystem. */
export const ECOSYSTEM_LOCKFILES: Record<Ecosystem, string[]> = {
  node: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'],
  python: ['uv.lock', 'poetry.lock', 'requirements.txt', 'Pipfile.lock'],
  rust: ['Cargo.lock'],
  go: ['go.sum'],
  'docker-compose': []
}

/** The stock instructions for Claude's drafts; a project can replace either in settings. */
export const DEFAULT_DRAFT_PROMPTS: DraftSettings = {
  commitPrompt: `Write a git commit message for the staged changes below.

- Summary: one line, imperative mood, at most 72 characters, no trailing period.
- Description: a few short sentences or bullets on what changed and why. Leave it empty when the summary says it all.

Reply with the summary on the first line, a blank line, then the description. No code fences, no preamble.`,
  pullRequestPrompt: `Write a GitHub pull request title and description for the branch below. Work mainly from its commit messages; use the file list and the diff, when one is included, for detail.

- Title: one line, at most 72 characters, no trailing period.
- Description: Markdown. Open with a short paragraph on what the change does and why, then a bulleted list of the notable changes. Mention anything a reviewer should look at closely.

Reply with the title on the first line, a blank line, then the description. No code fences around the whole reply, no preamble.`
}

/**
 * The stock instructions a grouping session opens with. The hunks themselves, and how the user
 * asked for them to be grouped, are appended after it.
 */
export const DEFAULT_GROUP_PROMPT = `Split the change below into groups a reviewer can read one at a time; the Groups pane beside the chat draws your answers. The hunks below are usually enough; when one needs more context, read the code with your file-reading and search tools rather than shell commands, so nothing waits on the user's approval, and keep the reading to what the grouping needs. Do not change any files.

- Group by feature: one group is one thing the change does, with its frontend, backend, database, tests and config parts together.
- When a feature is large, split it into sub-features under "parts"; a small feature has none.
- Order groups so a reviewer meets the foundations first (schemas, shared types, core logic) and what builds on them later.
- Give each group a short title in plain words, a summary of one to three sentences on what it does and why, and the layers it touches (frontend, backend, database, tests, config, docs, build).
- Every id below (h… for a hunk, f… for a whole file) goes in exactly one group or part. Keep a file's hunks apart when they belong to different features.
- Under "links", note where one feature builds on another — uses its types, calls its code, renders its data — from the feature built on to the one building on it, by their numbers in "groups" (1 is the first), with a few words on what passes between them. Leave out features that stand alone.

Reply with a fenced \`\`\`change-groups block holding JSON (no comments), then two or three sentences on how you grouped it. When asked to change the grouping later, reply with the whole updated block, using the same ids. The JSON is shaped like:
{"groups": [{"title": "Refund flow", "summary": "…", "layers": ["backend", "database"], "ids": ["h1", "h4"], "parts": [{"title": "…", "summary": "…", "layers": ["frontend"], "ids": ["h2", "f1"]}]}],
 "links": [{"from": 1, "to": 2, "label": "refund records"}]}`

/**
 * The stock instructions a concept-map session opens with. The pull request's own words, its
 * commits, every hunk under a short id, and how the user asked for it to be mapped are appended
 * after it.
 *
 * This asks for something different from a grouping. A grouping is a hierarchy of *parts* — a
 * feature and the pieces it is made of. This is a hierarchy of *meaning*: every rung is a complete
 * account of the whole change, just coarser, so going down adds precision and never new ground.
 * That is what lets the pane give the reader a zoom control rather than a list.
 */
export const DEFAULT_CONCEPT_PROMPT = `Map the change below as a hierarchy of concepts a reviewer can understand without reading the diff; the Concept Graph pane beside the chat draws your answers. The hunks below are usually enough; when one needs more context, read the code with your file-reading and search tools rather than shell commands, so nothing waits on the user's approval. Do not change any files.

# The hierarchy
- It is a hierarchy of meaning, not of parts. Every rung is a complete account of the whole change, just coarser. Going down adds precision; it never adds new ground. Nothing may appear at a deeper rung that was not already true, less precisely, at the rung above it.
- "root" is one concept: this whole change said once, in a sentence a reviewer would repeat to a colleague.
- Under it, nest as deep as the change deserves. A one-line config fix is one rung; a new subsystem may be four. Do not pad a shallow branch to match a deep one.
- Order children so a reviewer meets the foundations first and what builds on them later.

# Naming
- Name a concept for what it *is*, in the words of the thing being built — not for the edit. "Turns a filter into SQL", never "adds 40 lines to query.ts". The test: the name should make sense to someone who never opens the diff, and should still read true in six months when every line has moved.
- "summary" says what the concept is, in one to three sentences. Keep what the change did to it out of the summary — that is "effect".
- "effect" is added (it did not exist), reshaped, replaced, removed, or context (it already existed and this change only leans on it).
- "kind" is optional: your own word for what sort of thing it is — capability, policy, data shape, boundary, protocol.
- "layers" is where the code sits: frontend, backend, database, tests, config, docs, build.

# Code
- "ids" are the hunks a concept is the home of (h… for a hunk, f… for a whole file). Every id below goes in exactly one concept's "ids", anywhere in the hierarchy. A concept may own hunks and still have children — those are its groundwork.
- "cites" are hunks a concept points at but does not own, because they live under another concept. Use it sparingly, for the change that proves a point made elsewhere.
- "commits" are the shas a concept arrived in, from the commit list above.
- "paths" are files the concept concerns, **including files this change never touches**. This is how an existing thing gets on the map.
- Include concepts with no changed code at all, as "context": the thing this change plugs into, and the callers that will now get a different answer. A reviewer cannot judge whether a plug fits without seeing the socket. Find them by reading around the diff, and only claim one you actually looked at.

# Links
- "links" are sideways, across the hierarchy, never up and down it — nesting already says "contains". "from" leans on / replaces / implements "to".
- Name each end by its "ref" slug, or by its place in the hierarchy ("1", "2.3").
- "leans-on" is the one that matters most: from a context concept to the changed concept it depends on is what tells the reviewer what this change puts at risk without touching.

Reply with a fenced \`\`\`concept-graph block holding JSON (no comments), then two or three sentences on how you read the change. When asked to change the map later, reply with the whole updated block, using the same hunk ids. The JSON is shaped like:
{"root": {"title": "Adds a web search tool for agents", "summary": "…", "ref": "websearch", "effect": "added", "layers": ["backend"], "ids": [], "children": [
  {"title": "What the tool is", "summary": "…", "ref": "contract", "effect": "added", "layers": ["backend"], "ids": ["h1", "h2"], "commits": ["a1b2c3d"], "children": [
    {"title": "When the search fails", "summary": "…", "ref": "errors", "effect": "added", "layers": ["backend"], "ids": ["h3"]}]},
  {"title": "The toolkit that already serves tools", "summary": "…", "ref": "toolkit", "effect": "context", "layers": ["backend"], "ids": [], "paths": ["packages/daemon/src/agents/toolkit.ts"]}]},
 "links": [{"from": "contract", "to": "toolkit", "kind": "leans-on", "label": "registers itself"}]}`

export function defaultProjectSettings(ecosystems: Ecosystem[] = []): ProjectSettings {
  return {
    autoFetch: true,
    autoFetchInterval: '15m',
    worktree: {
      tool: true,
      worktreePath: '{{ repo }}/worktrees/{{ name }}'
    },
    copyFiles: [
      { pattern: '.env', strategy: 'copy' },
      { pattern: '.env.local', strategy: 'copy' },
      { pattern: '.env.*.local', strategy: 'copy' }
    ],
    caches: {
      rules: ecosystems.flatMap((ecosystem) => ECOSYSTEM_CACHES[ecosystem].map((rule) => ({ ...rule, ecosystem }))),
      reinstallOnLockChange: true,
      sharedStores: true
    },
    defaults: { autoStart: true, runtime: 'per-service', env: [], branchPrefix: '', dbSource: 'template' },
    cleanup: { dirtyDestroy: 'prompt', deleteBranch: 'ask', staleGc: true, staleDays: 14 },
    drafts: { ...DEFAULT_DRAFT_PROMPTS }
  }
}

export function applySettingsPatch(current: ProjectSettings, patch: ProjectSettingsPatch): ProjectSettings {
  return {
    autoFetch: patch.autoFetch ?? current.autoFetch,
    autoFetchInterval: patch.autoFetchInterval ?? current.autoFetchInterval,
    worktree: { ...current.worktree, ...(patch.worktree ?? {}) },
    copyFiles: patch.copyFiles ?? current.copyFiles,
    caches: { ...current.caches, ...(patch.caches ?? {}) },
    defaults: { ...current.defaults, ...(patch.defaults ?? {}) },
    cleanup: { ...current.cleanup, ...(patch.cleanup ?? {}) },
    drafts: { ...current.drafts, ...(patch.drafts ?? {}) }
  }
}

export type EditorId = 'vscode' | 'cursor' | 'zed' | 'jetbrains' | 'neovim' | 'custom'
export type TerminalId = 'ghostty' | 'alacritty' | 'kitty' | 'iterm' | 'terminal' | 'gnome-terminal' | 'custom'

/** Launch presets: {path} is the worktree root, {file}:{line} a jump target where supported. */
export const EDITOR_PRESETS: Record<EditorId, { label: string; command: string }> = {
  vscode: { label: 'VS Code', command: 'code {path}' },
  cursor: { label: 'Cursor', command: 'cursor {path}' },
  zed: { label: 'Zed', command: 'zed {path}' },
  jetbrains: { label: 'JetBrains', command: 'idea {path}' },
  neovim: { label: 'Neovim (in terminal)', command: 'nvim {path}' },
  custom: { label: 'Custom…', command: '' }
}

export const TERMINAL_PRESETS: Record<TerminalId, { label: string; command: string }> = {
  ghostty: { label: 'Ghostty', command: 'open -na Ghostty --args --working-directory={path}' },
  iterm: { label: 'iTerm2', command: 'open -a iTerm {path}' },
  terminal: { label: 'Terminal.app', command: 'open -a Terminal {path}' },
  alacritty: { label: 'Alacritty', command: 'alacritty --working-directory {path}' },
  kitty: { label: 'kitty', command: 'kitty --directory {path}' },
  'gnome-terminal': { label: 'GNOME Terminal', command: 'gnome-terminal --working-directory={path}' },
  custom: { label: 'Custom…', command: '' }
}

export function defaultAppSettings(): AppSettings {
  return {
    editor: { id: 'vscode', command: EDITOR_PRESETS.vscode.command },
    terminal: { id: 'terminal', command: TERMINAL_PRESETS.terminal.command },
    diff: { layout: 'split', wrap: false, lineNumbers: true },
    ports: { from: DEFAULT_PORT_RANGE[0], to: DEFAULT_PORT_RANGE[1] }
  }
}

export function mergeOptions(base: WorktreeOptions, patch: Partial<WorktreeOptions> | undefined): WorktreeOptions {
  if (!patch) return base
  return { ...base, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) } as WorktreeOptions
}

/** The environment of a worktree Canopy has never provisioned. */
export function emptyEnvironment(configured: boolean, configErrors: string[] = []): WorktreeEnvironment {
  return {
    state: 'none',
    stateReason: null,
    desired: 'stopped',
    configured,
    configErrors,
    services: [],
    databases: [],
    ports: {},
    env: [],
    provisioning: null,
    provisionedAt: null,
    copiedFiles: [],
    caches: [],
    envFile: null,
    startedAt: null,
    options: DEFAULT_WORKTREE_OPTIONS
  }
}

// ---------- templates ----------

/**
 * The directory a project owns under the Canopy home (`~/.canopy/<project>/`): its
 * canopy.yaml fallback and, by default, its worktrees. Also what `{{ repo }}` renders to,
 * so the two can never point at different directories for the same project.
 */
export const projectDirName = (name: string): string => name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'project'

/** What `{{ branch | sanitize }}` produces: `feat/login` becomes the directory `feat-login`. */
export const sanitizeBranch = (branch: string): string => branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')

/**
 * Renders Canopy's worktree-path template. Supports `{{ repo }}`, `{{ name }}`, `{{ branch }}`,
 * `{{ branch | sanitize }}`, `{{ repo_path }}`. A relative result is joined to `root`.
 */
export function renderWorktreePath(template: string, vars: { root: string; repo: string; repoPath: string; name: string; branch: string }): string {
  const rendered = template.replace(/\{\{\s*([a-z_]+)(?:\s*\|\s*([a-z_]+))?\s*\}\}/g, (_m, key: string, filter?: string) => {
    const value = key === 'repo' ? projectDirName(vars.repo) : key === 'name' ? vars.name : key === 'branch' ? vars.branch : key === 'repo_path' ? vars.repoPath : ''
    return filter === 'sanitize' ? sanitizeBranch(value) : value
  })
  // `~` is left for the daemon to expand (this runs in the browser too); absolute paths win over root.
  if (rendered.startsWith('/') || rendered.startsWith('~')) return rendered
  return `${vars.root.replace(/\/$/, '')}/${rendered}`
}

/** `${ports.x}`, `${db.x.url}`, `${worktree.name}`, `${project.name}`, `${env.KEY}` substitution. */
export function interpolate(text: string, scope: Record<string, Record<string, string>>): string {
  return text.replace(/\$\{([a-z_]+)\.([a-z0-9_-]+)(?:\.([a-z_]+))?\}/g, (whole, group: string, name: string, field?: string) => {
    const bucket = scope[group]
    if (!bucket) return whole
    const key = field ? `${name}.${field}` : name
    return bucket[key] ?? bucket[name] ?? whole
  })
}

// ---------- rollups ----------

type DotStatus = 'running' | 'success' | 'error' | 'idle'

export const SERVICE_DOT: Record<ServiceStatus, DotStatus> = {
  pending: 'idle',
  starting: 'running',
  healthy: 'success',
  unhealthy: 'error',
  restarting: 'running',
  stopping: 'running',
  stopped: 'idle',
  exited: 'error',
  failed: 'error'
}

export const SERVICE_LABEL: Record<ServiceStatus, string> = {
  pending: 'Pending',
  starting: 'Starting',
  healthy: 'Healthy',
  unhealthy: 'Unhealthy',
  restarting: 'Restarting',
  stopping: 'Stopping',
  stopped: 'Stopped',
  exited: 'Exited',
  failed: 'Failed'
}

export const ENV_STATE_LABEL: Record<EnvState, string> = {
  none: 'Not provisioned',
  creating: 'Creating',
  provisioning: 'Provisioning',
  stopped: 'Stopped',
  starting: 'Starting',
  running: 'Running',
  degraded: 'Degraded',
  stopping: 'Stopping',
  error: 'Error',
  destroying: 'Destroying'
}

/** One dot for a whole worktree: lifecycle first, then the worst service state. */
export function environmentDot(env: WorktreeEnvironment): DotStatus {
  if (env.state === 'error' || env.state === 'degraded') return 'error'
  if (['creating', 'provisioning', 'starting', 'stopping', 'destroying'].includes(env.state)) return 'running'
  if (env.state === 'stopped' || env.state === 'none') return 'idle'
  const active = env.services.filter((svc) => !svc.excluded)
  if (active.some((svc) => svc.status === 'unhealthy' || svc.status === 'exited' || svc.status === 'failed')) return 'error'
  if (active.some((svc) => svc.status === 'starting' || svc.status === 'restarting')) return 'running'
  return 'success'
}

export interface ResourceTotals {
  cpuPct: number
  memMb: number
  processes: number
}

export function serviceResources(services: ServiceInfo[]): ResourceTotals {
  let cpuPct = 0
  let memMb = 0
  let processes = 0
  for (const svc of services) {
    if (svc.excluded || svc.cpuPct === undefined) continue
    cpuPct += svc.cpuPct
    memMb += svc.memMb ?? 0
    processes += 1
  }
  return { cpuPct: Math.round(cpuPct * 10) / 10, memMb: Math.round(memMb), processes }
}

export const formatMem = (memMb: number): string => (memMb >= 1024 ? `${(memMb / 1024).toFixed(1)} GB` : `${Math.round(memMb)} MB`)

export const formatMs = (ms: number): string => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`)

/** Hides the password in `scheme://user:pass@host`. */
export const maskUrl = (url: string): string => url.replace(/\/\/([^:/@]+):[^@]+@/, '//$1:•••@')

/** Env keys that are secret by convention when the yaml/project does not say. */
export const looksSecret = (key: string): boolean => /(key|token|secret|password|passwd|pwd|credential)/i.test(key)

/** The first service with a port, preferring one named `web`/`app`/`frontend`. */
export function primaryService(services: ServiceInfo[]): ServiceInfo | undefined {
  const active = services.filter((svc) => !svc.excluded && svc.ports.length > 0)
  return active.find((svc) => ['web', 'app', 'frontend', 'ui', 'site'].includes(svc.name)) ?? active[0]
}

export const isLive = (state: EnvState): boolean => state === 'running' || state === 'degraded' || state === 'starting'

/** The env var that receives a database fork's URL/path: `spec.env` or `<NAME>_URL`. */
export const dbEnvKey = (name: string, spec: { env?: string | undefined }): string => spec.env ?? `${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_URL`
