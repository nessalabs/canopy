import { z } from 'zod'

import { Ecosystem, Id, Millis } from './common'

// =====================================================================================
// canopy.yaml — what a project runs. Parsed + defaulted into CanopyConfig.
// The same schema lints the file in the daemon and live in the settings editor.
// =====================================================================================

/** Names for services, ports, databases: safe in env var names, paths, container names. */
export const ResourceName = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, 'lowercase letters, digits, _ and - only')

/** "500ms", "5s", "2m". */
export const Duration = z.string().regex(/^\d+(ms|s|m)$/, 'a duration like 5s, 500ms or 2m')
export type Duration = z.infer<typeof Duration>

export const Runtime = z.enum(['host', 'docker', 'compose'])
export type Runtime = z.infer<typeof Runtime>

export const PortSpec = z.object({
  /** Tried first when free; otherwise a stable hash of project/branch/name picks one in range. */
  preferred: z.number().int().min(1).max(65535).optional(),
  /** Restricts allocation to [from, to]; defaults to the daemon's port range. */
  range: z.tuple([z.number().int().min(1).max(65535), z.number().int().min(1).max(65535)]).optional(),
  description: z.string().optional()
})
export type PortSpec = z.infer<typeof PortSpec>

export const HealthCheck = z
  .object({
    /** GET this URL; 2xx/3xx is healthy. Templates allowed (`${ports.api}`). */
    http: z.string().optional(),
    /** Connect to this port (number or `${ports.x}`) on localhost. */
    tcp: z.union([z.string(), z.number().int()]).optional(),
    /** Shell command run in the worktree with the service env; exit 0 is healthy. */
    cmd: z.string().optional(),
    interval: Duration.default('3s'),
    timeout: Duration.default('3s'),
    /** Consecutive failures before `unhealthy`. */
    retries: z.number().int().min(1).default(10),
    /** Grace period after start during which failures do not count. */
    start_period: Duration.default('0s')
  })
  .refine((h) => [h.http, h.tcp, h.cmd].filter((v) => v !== undefined).length === 1, { message: 'exactly one of http, tcp or cmd' })
export type HealthCheck = z.infer<typeof HealthCheck>

export const RestartPolicy = z.enum(['never', 'on-failure', 'always'])
export type RestartPolicy = z.infer<typeof RestartPolicy>

export const DockerSpec = z.object({
  image: z.string().optional(),
  /** Built (and cached by content hash) when set; `context` defaults to the worktree root. */
  dockerfile: z.string().optional(),
  context: z.string().optional(),
  /** Extra `-v` mounts, `host:container[:mode]`; relative host paths resolve inside the worktree. */
  volumes: z.array(z.string()).default([]),
  /** Extra raw `docker run` arguments. */
  args: z.array(z.string()).default([]),
  user: z.string().optional(),
  /** Where the worktree is mounted and `run` executes. */
  workdir: z.string().default('/workspace')
})
export type DockerSpec = z.infer<typeof DockerSpec>

export const ComposeSpec = z.object({
  file: z.string().default('docker-compose.yml'),
  /** Subset of compose services to bring up; empty = all. */
  services: z.array(z.string()).default([]),
  profiles: z.array(z.string()).default([])
})
export type ComposeSpec = z.infer<typeof ComposeSpec>

export const ServiceSpec = z.object({
  /** Shell command; required unless `compose` is set. */
  run: z.string().optional(),
  /** Relative to the worktree root. */
  cwd: z.string().optional(),
  /** Defaults to `defaults.runtime`; `compose` when `compose:` is set. */
  runtime: Runtime.optional(),
  env: z.record(z.string(), z.string()).default({}),
  /** Named ports this service listens on. Defaults to every `${ports.x}` its run/env mention. */
  ports: z.array(ResourceName).optional(),
  health: HealthCheck.optional(),
  depends_on: z.array(ResourceName).default([]),
  restart: RestartPolicy.default('on-failure'),
  /** `false` registers the service without starting it with the worktree. */
  autostart: z.boolean().default(true),
  docker: DockerSpec.optional(),
  compose: ComposeSpec.optional(),
  stop_signal: z.string().default('SIGTERM'),
  stop_timeout: Duration.default('10s'),
  description: z.string().optional()
})
export type ServiceSpec = z.infer<typeof ServiceSpec>

export const DbAdapterName = z.enum(['postgres', 'mysql', 'sqlite', 'redis'])
export type DbAdapterName = z.infer<typeof DbAdapterName>

export const DbSeed = z.object({
  /** pg_dump custom/plain file or mysqldump file, relative to the repo. */
  dump: z.string().optional(),
  /** Plain SQL file. */
  sql: z.string().optional(),
  /** Shell command run once against the fresh template with the DB url in env (migrations, seeders). */
  command: z.string().optional()
})
export type DbSeed = z.infer<typeof DbSeed>

export const DatabaseSpec = z.object({
  adapter: DbAdapterName,
  /** Engine version tag (postgres "16", mysql "8", redis "7"). */
  version: z.string().optional(),
  seed: DbSeed.optional(),
  /** sqlite: file copied for each fork. */
  source: z.string().optional(),
  /** Env var that receives the fork's URL/path; defaults to `<NAME>_URL`. */
  env: z.string().optional(),
  /** redis: `host` runs `redis-server` on the host when installed; default docker. */
  runtime: z.enum(['docker', 'host']).optional(),
  /** Adapter-specific knobs (e.g. postgres `extensions`). */
  options: z.record(z.string(), z.string()).default({})
})
export type DatabaseSpec = z.infer<typeof DatabaseSpec>

export const SetupStep = z.object({
  run: z.string(),
  name: z.string().optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
  /** Skip when these files (globs) have the same content as in the source checkout. */
  if_changed: z.array(z.string()).optional()
})
export type SetupStep = z.infer<typeof SetupStep>

export const CanopyConfig = z.object({
  version: z.literal(1),
  name: z.string().optional(),
  defaults: z
    .object({
      runtime: Runtime.default('host'),
      env: z.record(z.string(), z.string()).default({})
    })
    .default({ runtime: 'host', env: {} }),
  /** Project-wide env, layered under every service and setup step. */
  env: z.record(z.string(), z.string()).default({}),
  ports: z.record(ResourceName, PortSpec).default({}),
  databases: z.record(ResourceName, DatabaseSpec).default({}),
  setup: z.array(z.union([z.string(), SetupStep])).default([]),
  services: z.record(ResourceName, ServiceSpec).default({}),
  /** Dotenv Canopy writes into each worktree with everything resolved; `false` disables. */
  env_file: z.union([z.string(), z.literal(false)]).default('.env.canopy')
})
export type CanopyConfig = z.infer<typeof CanopyConfig>

export const CANOPY_TOP_KEYS = ['version', 'name', 'defaults', 'env', 'ports', 'databases', 'setup', 'services', 'env_file'] as const

/** What the daemon reports about a project's canopy.yaml. */
export const CanopyYamlReport = z.object({
  present: z.boolean(),
  valid: z.boolean(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  services: z.number().int(),
  ports: z.number().int(),
  databases: z.number().int()
})
export type CanopyYamlReport = z.infer<typeof CanopyYamlReport>

// =====================================================================================
// Project settings — Canopy-owned preferences for one project on this daemon.
// =====================================================================================

export const CopyStrategy = z.enum(['copy', 'symlink'])
export const CopyFileRule = z.object({
  /** Glob relative to the repo root (`.env`, `config/*.local.json`). */
  pattern: z.string().min(1),
  strategy: CopyStrategy,
  /** Suggested by the scan of the primary checkout. */
  detected: z.boolean().optional()
})
export type CopyFileRule = z.infer<typeof CopyFileRule>

/**
 * How a cache directory reaches a new worktree.
 *   clone   copy-on-write clone (APFS clonefile / Linux reflink), falls back to copy — near-instant, disk-cheap
 *   copy    plain recursive copy
 *   symlink share the source directory (fast; installs in one worktree affect all)
 *   fresh   nothing — setup/install recreates it
 */
export const CacheStrategy = z.enum(['clone', 'copy', 'symlink', 'fresh'])
export type CacheStrategy = z.infer<typeof CacheStrategy>

export const CacheRule = z.object({
  /** Directory or glob relative to the repo root (`node_modules`, `packages/ * /node_modules`, `.venv`, `target`). */
  path: z.string().min(1),
  strategy: CacheStrategy,
  ecosystem: Ecosystem.optional(),
  detected: z.boolean().optional()
})
export type CacheRule = z.infer<typeof CacheRule>

export const CacheSettings = z.object({
  rules: z.array(CacheRule),
  /** After clone/copy, run the ecosystem's install when the worktree's lockfile differs from the source's. */
  reinstallOnLockChange: z.boolean(),
  /** Point package managers at machine-wide stores (uv cache, pnpm store) so fresh installs hardlink instead of download. */
  sharedStores: z.boolean()
})
export type CacheSettings = z.infer<typeof CacheSettings>

export const WORKTRUNK_HOOKS = ['pre-switch', 'post-switch', 'pre-start', 'post-start', 'pre-commit', 'post-commit', 'pre-merge', 'post-merge', 'pre-remove', 'post-remove'] as const
export const WorktrunkHook = z.enum(WORKTRUNK_HOOKS)
export type WorktrunkHook = z.infer<typeof WorktrunkHook>

export const WorktrunkHookRule = z.object({
  hook: WorktrunkHook,
  /** TOML key inside the hook table; several commands per hook run concurrently. */
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/).optional(),
  command: z.string(),
  /** Wired by Canopy (provision/teardown callbacks). */
  canopy: z.boolean().optional()
})
export type WorktrunkHookRule = z.infer<typeof WorktrunkHookRule>

export const WorktrunkSettings = z.object({
  /** Drive worktrees through `wt` when it is installed; otherwise plain git. */
  enabled: z.boolean(),
  /**
   * Where worktrees are created. Canopy renders `{{ repo }}`, `{{ name }}`, `{{ branch }}`,
   * `{{ branch | sanitize }}` and `{{ repo_path }}`; the result is passed to wt per call.
   */
  worktreePath: z.string().min(1),
  hooks: z.array(WorktrunkHookRule),
  /** Keep `.config/wt.toml` in the primary checkout in sync with `hooks` and `listUrl`. */
  syncProjectConfig: z.boolean(),
  /** `[list] url` template shown by `wt list`; empty leaves it alone. */
  listUrl: z.string()
})
export type WorktrunkSettings = z.infer<typeof WorktrunkSettings>

export const ProjectEnvVar = z.object({ key: z.string(), value: z.string(), secret: z.boolean().optional() })
export type ProjectEnvVar = z.infer<typeof ProjectEnvVar>

export const DbSource = z.union([z.literal('template'), z.literal('empty'), z.object({ fromWorktree: Id })])
export type DbSource = z.infer<typeof DbSource>

export const CacheSource = z.union([z.literal('primary'), z.object({ fromWorktree: Id })])
export type CacheSource = z.infer<typeof CacheSource>

export const WorktreeDefaults = z.object({
  autoStart: z.boolean(),
  /** `per-service` follows canopy.yaml; host/docker force every service that supports it. */
  runtime: z.enum(['per-service', 'host', 'docker']),
  env: z.array(ProjectEnvVar),
  branchPrefix: z.string(),
  dbSource: z.enum(['template', 'empty'])
})
export type WorktreeDefaults = z.infer<typeof WorktreeDefaults>

export const CleanupSettings = z.object({
  dirtyDestroy: z.enum(['block', 'prompt']),
  deleteBranch: z.enum(['never', 'if-merged', 'ask']),
  staleGc: z.boolean(),
  staleDays: z.number().int().min(1)
})
export type CleanupSettings = z.infer<typeof CleanupSettings>

export const ProjectSettings = z.object({
  autoFetch: z.boolean(),
  autoFetchInterval: z.enum(['5m', '15m', '1h']),
  worktrunk: WorktrunkSettings,
  copyFiles: z.array(CopyFileRule),
  caches: CacheSettings,
  defaults: WorktreeDefaults,
  cleanup: CleanupSettings
})
export type ProjectSettings = z.infer<typeof ProjectSettings>

/** Deep-partial patch; arrays replace wholesale. */
export const ProjectSettingsPatch = z.object({
  autoFetch: z.boolean().optional(),
  autoFetchInterval: ProjectSettings.shape.autoFetchInterval.optional(),
  worktrunk: WorktrunkSettings.partial().optional(),
  copyFiles: z.array(CopyFileRule).optional(),
  caches: CacheSettings.partial().optional(),
  defaults: WorktreeDefaults.partial().optional(),
  cleanup: CleanupSettings.partial().optional()
})
export type ProjectSettingsPatch = z.infer<typeof ProjectSettingsPatch>

// =====================================================================================
// App settings — this machine, every project.
// =====================================================================================

export const LaunchCommand = z.object({
  /** Preset id (`vscode`, `ghostty`, …) or `custom`. */
  id: z.string(),
  /** `{path}` = worktree root; `{file}`/`{line}` where supported. */
  command: z.string()
})
export const AppSettings = z.object({
  editor: LaunchCommand,
  terminal: LaunchCommand,
  diff: z.object({ layout: z.enum(['split', 'unified']), wrap: z.boolean(), lineNumbers: z.boolean() }),
  ports: z.object({ from: z.number().int().min(1024).max(65535), to: z.number().int().min(1024).max(65535) })
})
export type AppSettings = z.infer<typeof AppSettings>
export const AppSettingsPatch = z.object({
  editor: LaunchCommand.optional(),
  terminal: LaunchCommand.optional(),
  diff: AppSettings.shape.diff.partial().optional(),
  ports: AppSettings.shape.ports.optional()
})
export type AppSettingsPatch = z.infer<typeof AppSettingsPatch>

// =====================================================================================
// Worktree environment — live state attached to every Worktree.
// =====================================================================================

export const EnvState = z.enum(['none', 'creating', 'provisioning', 'stopped', 'starting', 'running', 'degraded', 'stopping', 'error', 'destroying'])
export type EnvState = z.infer<typeof EnvState>

export const DesiredState = z.enum(['running', 'stopped'])
export type DesiredState = z.infer<typeof DesiredState>

export const ServiceStatus = z.enum(['pending', 'starting', 'healthy', 'unhealthy', 'restarting', 'stopping', 'stopped', 'exited', 'failed'])
export type ServiceStatus = z.infer<typeof ServiceStatus>

export const ServicePort = z.object({ name: ResourceName, port: z.number().int() })

export const ServiceInfo = z.object({
  name: ResourceName,
  runtime: Runtime,
  command: z.string(),
  cwd: z.string().optional(),
  ports: z.array(ServicePort),
  status: ServiceStatus,
  restarts: z.number().int(),
  pid: z.number().int().optional(),
  containerId: z.string().optional(),
  cpuPct: z.number().optional(),
  memMb: z.number().optional(),
  /** Deselected for this worktree; never started. */
  excluded: z.boolean(),
  autostart: z.boolean(),
  health: z.enum(['none', 'http', 'tcp', 'cmd']),
  dependsOn: z.array(ResourceName),
  startedAt: Millis.nullable(),
  exitCode: z.number().int().nullable(),
  lastError: z.string().nullable()
})
export type ServiceInfo = z.infer<typeof ServiceInfo>

export const DbStatus = z.enum(['pending', 'forking', 'ready', 'error', 'missing'])
export type DbStatus = z.infer<typeof DbStatus>

export const DbInstanceInfo = z.object({
  name: ResourceName,
  adapter: DbAdapterName,
  status: DbStatus,
  /** Full URL/path; the UI masks credentials. */
  connectionUrl: z.string().nullable(),
  envKey: z.string(),
  /** Human lineage: "seed template", "empty", "worktree billing". */
  forkedFrom: z.string(),
  /**
   * The concrete artifact copied — database name or file path; null when the fork started
   * empty, and absent on rows a daemon older than the client never recorded lineage for.
   */
  forkedFromDatabase: z.string().nullish(),
  /** Branch checked out in the source worktree, when this was forked from one. */
  forkedFromBranch: z.string().nullish(),
  sizeMb: z.number().nullable(),
  seededAt: Millis.nullable(),
  /** Adapter facts for the tiles: container, database, file, port. */
  detail: z.record(z.string(), z.string()),
  error: z.string().nullable()
})
export type DbInstanceInfo = z.infer<typeof DbInstanceInfo>

export const PROVISION_STEPS = ['create-worktree', 'copy-files', 'link-caches', 'allocate-ports', 'fork-databases', 'write-env', 'run-setup', 'start-services'] as const
export const ProvisionStepName = z.enum(PROVISION_STEPS)
export type ProvisionStepName = z.infer<typeof ProvisionStepName>

export const ProvisionStepStatus = z.enum(['pending', 'active', 'done', 'failed', 'skipped'])
export type ProvisionStepStatus = z.infer<typeof ProvisionStepStatus>

export const ProvisionStep = z.object({
  name: ProvisionStepName,
  status: ProvisionStepStatus,
  startedAt: Millis.nullable(),
  durationMs: z.number().nullable(),
  /** One mono line: what the step did (`node_modules cloned (CoW) · .next copied`). */
  detail: z.string().nullable(),
  error: z.string().nullable()
})
export type ProvisionStep = z.infer<typeof ProvisionStep>

export const ProvisionRun = z.object({
  id: Id,
  status: z.enum(['running', 'done', 'failed']),
  steps: z.array(ProvisionStep),
  startedAt: Millis,
  finishedAt: Millis.nullable()
})
export type ProvisionRun = z.infer<typeof ProvisionRun>

export const EnvSource = z.enum(['yaml', 'port', 'db', 'project', 'override', 'canopy'])
export type EnvSource = z.infer<typeof EnvSource>

export const EnvVar = z.object({ key: z.string(), value: z.string(), source: EnvSource, secret: z.boolean() })
export type EnvVar = z.infer<typeof EnvVar>

export const CacheResult = z.object({
  path: z.string(),
  strategy: CacheStrategy,
  result: z.enum(['cloned', 'copied', 'linked', 'skipped', 'missing', 'failed']),
  durationMs: z.number().nullable(),
  detail: z.string().nullable()
})
export type CacheResult = z.infer<typeof CacheResult>

/** Per-worktree choices made at create time; editable later via provision. */
export const WorktreeOptions = z.object({
  /** Included service names; null = every service in canopy.yaml. */
  services: z.array(ResourceName).nullable(),
  env: z.array(ProjectEnvVar),
  dbSource: DbSource,
  /** Overrides per cache path. */
  caches: z.record(z.string(), CacheStrategy),
  cacheSource: CacheSource,
  skipSetup: z.boolean(),
  /** Force a runtime for every service that supports it; null follows canopy.yaml. */
  runtime: z.enum(['host', 'docker']).nullable()
})
export type WorktreeOptions = z.infer<typeof WorktreeOptions>

export const DEFAULT_WORKTREE_OPTIONS: WorktreeOptions = {
  services: null,
  env: [],
  dbSource: 'template',
  caches: {},
  cacheSource: 'primary',
  skipSetup: false,
  runtime: null
}

export const WorktreeEnvironment = z.object({
  state: EnvState,
  stateReason: z.string().nullable(),
  desired: DesiredState,
  /** A valid canopy.yaml is in effect for this worktree. */
  configured: z.boolean(),
  configErrors: z.array(z.string()),
  services: z.array(ServiceInfo),
  databases: z.array(DbInstanceInfo),
  ports: z.record(ResourceName, z.number().int()),
  env: z.array(EnvVar),
  provisioning: ProvisionRun.nullable(),
  provisionedAt: Millis.nullable(),
  copiedFiles: z.array(z.string()),
  caches: z.array(CacheResult),
  /** Path of the generated dotenv relative to the worktree, or null. */
  envFile: z.string().nullable(),
  startedAt: Millis.nullable(),
  options: WorktreeOptions
})
export type WorktreeEnvironment = z.infer<typeof WorktreeEnvironment>

// =====================================================================================
// Logs, resources, host, events
// =====================================================================================

export const LogStream = z.enum(['out', 'err', 'sys'])
export type LogStream = z.infer<typeof LogStream>

export const LogLine = z.object({ offset: z.number().int(), ts: Millis, stream: LogStream, text: z.string() })
export type LogLine = z.infer<typeof LogLine>

export const LogsResponse = z.object({ lines: z.array(LogLine), nextOffset: z.number().int(), truncated: z.boolean() })
export type LogsResponse = z.infer<typeof LogsResponse>

export const LogEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('line'), line: LogLine }),
  /** The log was rotated/cleared; the client should drop what it has. */
  z.object({ type: z.literal('reset'), nextOffset: z.number().int() }),
  z.object({ type: z.literal('end') })
])
export type LogEvent = z.infer<typeof LogEvent>

/** Used for the per-service names of the built-in streams. */
export const PROVISION_LOG = 'provision'

export const ServiceUsage = z.object({ cpuPct: z.number(), memMb: z.number() })

export const HostSample = z.object({
  t: Millis,
  cpuPct: z.number(),
  /** Per-core utilization 0–100. */
  cores: z.array(z.number()),
  memUsedMb: z.number(),
  memTotalMb: z.number()
})
export type HostSample = z.infer<typeof HostSample>

export const ResourceSample = z.object({
  t: Millis,
  services: z.record(z.string(), ServiceUsage),
  totalCpuPct: z.number(),
  totalMemMb: z.number()
})
export type ResourceSample = z.infer<typeof ResourceSample>

export const ResourcesResponse = z.object({ samples: z.array(ResourceSample), host: z.array(HostSample) })
export type ResourcesResponse = z.infer<typeof ResourcesResponse>

export const ToolInfo = z.object({ available: z.boolean(), version: z.string().nullable(), path: z.string().nullable() })

export const HostInfo = z.object({
  platform: z.string(),
  arch: z.string(),
  hostname: z.string(),
  cores: z.number().int(),
  memMb: z.number(),
  docker: ToolInfo,
  worktrunk: ToolInfo,
  worktreeRoot: z.string(),
  dataRoot: z.string(),
  portRange: z.tuple([z.number().int(), z.number().int()]),
  /** Command for hooks to reach this daemon (`canopy` on PATH, else an absolute node invocation). */
  canopyCommand: z.string()
})
export type HostInfo = z.infer<typeof HostInfo>

export const CanopyEvent = z.discriminatedUnion('type', [
  /** `watch`: this daemon pushes `files-changed` events; without it clients keep polling. */
  z.object({ type: z.literal('hello'), seq: z.number().int(), watch: z.boolean().optional() }),
  /** Buffer miss on resume: refetch everything. */
  z.object({ type: z.literal('reset'), seq: z.number().int() }),
  z.object({ type: z.literal('environment'), seq: z.number().int(), worktreeId: Id, environment: WorktreeEnvironment }),
  z.object({ type: z.literal('worktree-removed'), seq: z.number().int(), worktreeId: Id }),
  /** Worktrees appeared/changed outside the environment (created, synced, renamed). */
  z.object({ type: z.literal('worktrees-changed'), seq: z.number().int(), projectId: Id.optional() }),
  z.object({ type: z.literal('project-changed'), seq: z.number().int(), projectId: Id }),
  z.object({ type: z.literal('resources'), seq: z.number().int(), worktreeId: Id, sample: ResourceSample }),
  z.object({ type: z.literal('host'), seq: z.number().int(), sample: HostSample }),
  /**
   * Files in a watched worktree changed on disk: `paths` are repo-relative and not ignored,
   * `git` says the repository itself moved (index, HEAD, refs), and `truncated` that a burst
   * was too large to list — treat everything about the worktree as stale then.
   */
  z.object({ type: z.literal('files-changed'), seq: z.number().int(), worktreeId: Id, paths: z.array(z.string()), git: z.boolean(), truncated: z.boolean() }),
  /** An agent session worked in this worktree for the first time (from its own cwd or another). */
  z.object({ type: z.literal('agent-sessions-changed'), seq: z.number().int(), worktreeId: Id })
])
export type CanopyEvent = z.infer<typeof CanopyEvent>

// =====================================================================================
// Requests
// =====================================================================================

export const ProvisionInput = z.object({
  /** Resume from this step (default: the failed step, else the first applicable one). */
  from: ProvisionStepName.optional(),
  /** Replaces the stored options when given (partial merge). */
  options: WorktreeOptions.partial().optional(),
  autoStart: z.boolean().optional()
})
export type ProvisionInput = z.infer<typeof ProvisionInput>

export const AdoptWorktreeInput = z.object({ path: z.string().min(1), autoStart: z.boolean().optional() })
export type AdoptWorktreeInput = z.infer<typeof AdoptWorktreeInput>

export const ServiceAction = z.enum(['start', 'stop', 'restart'])
export type ServiceAction = z.infer<typeof ServiceAction>

export const DbResetInput = z.object({ from: DbSource.optional() })
export type DbResetInput = z.infer<typeof DbResetInput>

export const OpenTarget = z.enum(['editor', 'terminal'])
export type OpenTarget = z.infer<typeof OpenTarget>
export const OpenInput = z.object({ target: OpenTarget, file: z.string().optional(), line: z.number().int().optional() })
export type OpenInput = z.infer<typeof OpenInput>

export const ConfigWriteInput = z.object({ raw: z.string() })

/** Resolved preview of a project's canopy.yaml from its primary checkout — drives the create form and settings. */
export const ProjectEnvironmentPreview = z.object({
  report: CanopyYamlReport,
  services: z.array(
    z.object({
      name: ResourceName,
      runtime: Runtime,
      command: z.string(),
      ports: z.array(ResourceName),
      autostart: z.boolean(),
      dependsOn: z.array(ResourceName),
      description: z.string().nullable()
    })
  ),
  ports: z.array(z.object({ name: ResourceName, preferred: z.number().int().nullable() })),
  databases: z.array(z.object({ name: ResourceName, adapter: DbAdapterName, envKey: z.string() })),
  setup: z.array(z.string()),
  /** Env the yaml itself declares (before ports/dbs resolve). */
  env: z.array(EnvVar),
  envFile: z.string().nullable(),
  /** Cache dirs present in the primary checkout, with the strategy the settings give them. */
  detectedCaches: z.array(CacheRule),
  /** Ignored files present in the primary checkout that no copy rule covers. */
  detectedCopyCandidates: z.array(z.string())
})
export type ProjectEnvironmentPreview = z.infer<typeof ProjectEnvironmentPreview>

/**
 * The commit a destroy left behind. Forcing past the dirty check discards work that was never
 * committed anywhere, so the daemon saves it under a ref first and says where it went.
 */
export const Salvage = z.object({ ref: z.string(), sha: z.string(), files: z.number().int() })
export type Salvage = z.infer<typeof Salvage>

export const DestroyResult = z.object({ salvaged: Salvage.nullable() })
export type DestroyResult = z.infer<typeof DestroyResult>

/**
 * One thing in a project's trash: a worktree that was destroyed with uncommitted work in it,
 * and everything needed to put it back where it was.
 */
export const TrashEntry = z.object({
  id: z.string(),
  ref: z.string(),
  name: z.string(),
  branch: z.string().nullable(),
  path: z.string(),
  base: z.string().nullable(),
  files: z.number().int(),
  destroyedAt: z.number()
})
export type TrashEntry = z.infer<typeof TrashEntry>

export const DestroyAllInput = z.object({ force: z.boolean().optional(), deleteBranch: z.boolean().optional() })
export type DestroyAllInput = z.infer<typeof DestroyAllInput>

// =====================================================================================
// File-system browsing (picking a repository folder on the daemon's machine)
// =====================================================================================

export const DirEntry = z.object({
  name: z.string(),
  /** Absolute path. */
  path: z.string(),
  /** Files are listed for orientation and search; only directories can be entered or picked. */
  kind: z.enum(['dir', 'file']),
  /** `.git` (directory or worktree file) is present (directories only). */
  isGitRepo: z.boolean(),
  hidden: z.boolean()
})
export type DirEntry = z.infer<typeof DirEntry>

export const DirListing = z.object({
  /** Resolved absolute path that was listed (`~` expanded, symlinks kept). */
  path: z.string(),
  /** Null at the filesystem root. */
  parent: z.string().nullable(),
  home: z.string(),
  /** The listed directory itself is a git repository. */
  isGitRepo: z.boolean(),
  /** Directories first, then files; hidden entries last within each group. */
  entries: z.array(DirEntry),
  /** The folder had more entries than the listing cap; use the filter or step in. */
  truncated: z.boolean()
})
export type DirListing = z.infer<typeof DirListing>
