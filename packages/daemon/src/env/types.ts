/**
 * Internal contracts of the environment subsystem. Everything that differs per runtime or
 * per database engine sits behind one of these interfaces; the pipeline, the supervisor and
 * the routes only ever see the interface. Wire types come from @canopy/shared.
 */
import type {
  BranchSpec,
  CacheResult,
  CanopyConfig,
  CanopyEvent,
  DatabaseSpec,
  DbInstanceInfo,
  DbSource,
  Ecosystem,
  EnvVar,
  LogLine,
  LogStream,
  ProjectSettings,
  ProvisionRun,
  ProvisionStepName,
  ResourceSample,
  ServiceInfo,
  ServiceSpec,
  Worktree,
  WorktreeEnvironment,
  WorktreeOptions
} from '@canopy/shared'

// ---------- logs ----------

/**
 * Append-only per-stream logs: NDJSON on disk (`<dataRoot>/<worktreeId>/logs/<stream>.ndjson`),
 * an in-memory ring for instant backfill, and subscribers for live follow. Offsets are
 * monotonic per stream and survive daemon restarts (the file is scanned on first open).
 */
export interface LogStore {
  append(worktreeId: string, stream: string, line: { stream: LogStream; text: string; ts?: number }): LogLine
  /** Lines with offset >= since, at most `limit`; `truncated` when older lines exist before `since`. */
  read(worktreeId: string, stream: string, since: number, limit: number): Promise<{ lines: LogLine[]; nextOffset: number; truncated: boolean }>
  /** Live lines as they land; returns the unsubscribe. */
  subscribe(worktreeId: string, stream: string, listener: (line: LogLine) => void): () => void
  /** Empties a stream (offsets keep increasing). */
  clear(worktreeId: string, stream: string): Promise<void>
  /** Removes every stream of a worktree (destroy). */
  remove(worktreeId: string): Promise<void>
  /** Flushes and closes open handles. */
  close(): Promise<void>
}

/** Convenience for step/supervisor code: a sink for one stream. */
export interface LogSink {
  out(text: string): void
  err(text: string): void
  sys(text: string): void
}

// ---------- events ----------

export type CanopyEventInput = CanopyEvent extends infer E ? (E extends { seq: number } ? Omit<E, 'seq'> : never) : never

export interface EventBus {
  emit(event: CanopyEventInput): CanopyEvent
  /** Events with seq > since when still buffered; null when the buffer no longer reaches back that far. */
  replay(since: number): CanopyEvent[] | null
  subscribe(listener: (event: CanopyEvent) => void): () => void
  readonly seq: number
}

// ---------- service runners ----------

export interface ResolvedService {
  name: string
  spec: ServiceSpec
  runtime: 'host' | 'docker' | 'compose'
  /** Fully interpolated command. */
  command: string
  /** Absolute working directory. */
  cwd: string
  /** Fully resolved env for the process (service env layered over the worktree env). */
  env: Record<string, string>
  /** Named ports the service owns → allocated numbers. */
  ports: Array<{ name: string; port: number }>
  stopSignal: NodeJS.Signals
  stopTimeoutMs: number
}

export interface RunContext {
  worktreeId: string
  worktreePath: string
  projectName: string
  dataDir: string
  logs: LogSink
}

/** What a runner hands back: enough to find the process/container again after a restart. */
export interface RunningHandle {
  kind: 'host' | 'docker' | 'compose'
  pid?: number
  /** Seconds since epoch the process started, to detect pid reuse. */
  pidStart?: number
  containerId?: string
  /** Compose project name. */
  composeProject?: string
  /** Resolves when the process/container exits. */
  exited: Promise<{ code: number | null; signal: string | null }>
}

/**
 * One supervision contract, three implementations. Health checks, depends_on, restart policy,
 * log capture and resource accounting all live above this in the supervisor.
 */
export interface ServiceRunner {
  readonly kind: 'host' | 'docker' | 'compose'
  start(ctx: RunContext, service: ResolvedService): Promise<RunningHandle>
  /** Graceful stop (signal / `docker stop`) then kill after the timeout. Idempotent. */
  stop(handle: RunningHandle, service: ResolvedService, ctx: RunContext): Promise<void>
  /** Whether the thing behind the handle is still alive (pid start-time checked). */
  alive(handle: RunningHandle): Promise<boolean>
  /** Kills whatever a previous daemon left behind for this worktree/service (boot reconcile, destroy). */
  reap(ctx: RunContext, service: ResolvedService, previous: Pick<RunningHandle, 'pid' | 'pidStart' | 'containerId' | 'composeProject'>): Promise<void>
}

// ---------- databases ----------

export interface DbContext {
  projectId: string
  projectName: string
  /** Primary checkout, where seed files live. */
  projectPath: string
  worktreeId: string
  worktreeName: string
  /** Branch checked out in the worktree; null when detached. */
  worktreeBranch: string | null
  worktreePath: string
  /** `<dataRoot>/<worktreeId>` — where file-backed forks live. */
  dataDir: string
  logs: LogSink
  /** Allocates (or returns the persisted) port for a database that needs one. */
  allocatePort(name: string): Promise<number>
  /** Shell env for seed commands (worktree env so far). */
  env: Record<string, string>
}

export interface DbFork {
  /** URL or path consumers use from the host. */
  url: string
  detail: Record<string, string>
  sizeMb: number | null
  /** What the fork was actually copied from — database name or file path; null when it started empty. */
  sourceDatabase: string | null
}

/**
 * One engine, one adapter. `ensureSource` builds/refreshes the shared seed template (once per
 * project+db), `fork` makes an isolated copy for a worktree, `destroy` removes it.
 */
export interface DbAdapter {
  readonly adapter: DatabaseSpec['adapter']
  /** Whether the engine is usable now (docker daemon up, redis-server on PATH, …). */
  available(): Promise<{ ok: boolean; reason?: string }>
  ensureSource(name: string, spec: DatabaseSpec, ctx: DbContext, opts: { refresh: boolean }): Promise<void>
  fork(name: string, spec: DatabaseSpec, ctx: DbContext, source: DbSource, sourceCtx?: DbContext): Promise<DbFork>
  destroy(name: string, spec: DatabaseSpec, ctx: DbContext): Promise<void>
  /** Cheap liveness/size probe for the dashboard. */
  status(name: string, spec: DatabaseSpec, ctx: DbContext): Promise<{ ready: boolean; sizeMb: number | null }>
}

// ---------- pipeline ----------

export interface ProvisionContext {
  worktreeId: string
  worktreeName: string
  project: { id: string; name: string; path: string; defaultBase: string; ecosystems: Ecosystem[] }
  settings: ProjectSettings
  options: WorktreeOptions
  /** Null when the project has no valid canopy.yaml: only create-worktree/copy-files/link-caches apply. */
  config: CanopyConfig | null
  /** Absolute worktree path (the target; exists after create-worktree). */
  worktreePath: string
  /** Where copied files and caches come from: the primary checkout or a sibling worktree. */
  sourcePath: string
  branch: string | null
  /** How to create the worktree; null when it already exists. */
  branchSpec: BranchSpec | null
  autoStart: boolean
  dataDir: string
  logs: LogSink
  /** Cancelled when the worktree is destroyed mid-provision. */
  signal: AbortSignal
  /** Accumulated results, filled by the steps in order. */
  state: ProvisionState
}

export interface ProvisionState {
  copiedFiles: string[]
  caches: CacheResult[]
  ports: Record<string, number>
  databases: DbInstanceInfo[]
  env: EnvVar[]
  envFile: string | null
  /** Ecosystems whose lockfile differs from the source — setup must reinstall. */
  reinstall: Ecosystem[]
}

export interface ProvisionStepImpl {
  name: ProvisionStepName
  /** False skips the step (recorded as `skipped` with `reason`). */
  applies(ctx: ProvisionContext): { run: true } | { run: false; reason: string }
  run(ctx: ProvisionContext): Promise<{ detail: string }>
}

// ---------- environment façade (what routes call) ----------

export interface EnvironmentApi {
  environmentOf(worktreeId: string): WorktreeEnvironment
  provision(worktreeId: string, input: { from?: ProvisionStepName; options?: Partial<WorktreeOptions>; autoStart?: boolean }): Promise<ProvisionRun>
  start(worktreeId: string): Promise<void>
  stop(worktreeId: string): Promise<void>
  restart(worktreeId: string): Promise<void>
  serviceAction(worktreeId: string, service: string, action: 'start' | 'stop' | 'restart'): Promise<void>
  resetDatabase(worktreeId: string, db: string, from?: DbSource): Promise<void>
  regenerateEnvFile(worktreeId: string): Promise<void>
  /** Stops services, drops forks, frees ports, removes data. Called before the worktree dir goes. */
  teardown(worktreeId: string): Promise<void>
  resources(worktreeId: string): ResourceSample[]
  servicesOf(worktreeId: string): ServiceInfo[]
  /** Kill-and-respawn everything recorded, then start what was desired running. */
  reconcile(worktrees: Worktree[]): Promise<void>
  shutdown(): Promise<void>
}

// ---------- docker ----------

export interface ContainerSummary {
  id: string
  name: string
  image: string
  state: string
  labels: Record<string, string>
}

/**
 * Thin wrapper over the `docker` CLI (no dockerode: the CLI is what users already have
 * authenticated and it works with Docker Desktop, Colima, Podman-docker alike).
 */
export interface DockerHelper {
  /** Cached for a few seconds; `available: false` when the CLI or the daemon is missing. */
  info(): Promise<{ available: boolean; version: string | null; path: string | null }>
  /** Runs `docker <args>`; rejects with the stderr text on non-zero exit unless `okCodes` allows it. */
  run(args: string[], opts?: { okCodes?: number[]; input?: string; cwd?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }>
  /** Spawns `docker <args>` and streams stdout/stderr lines; resolves on exit. */
  stream(args: string[], onLine: (stream: 'out' | 'err', text: string) => void, opts?: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal }): Promise<{ exitCode: number | null }>
  /** Containers matching every label (`canopy.worktree=<id>`), running or not. */
  ps(labels: Record<string, string>, opts?: { all?: boolean }): Promise<ContainerSummary[]>
  inspect(idOrName: string): Promise<Record<string, unknown> | null>
  /** `docker stop -t <s>` then `rm -f`; never throws for a missing container. */
  remove(idOrName: string, opts?: { stopTimeoutSec?: number; volumes?: boolean }): Promise<void>
  /** One `docker stats --no-stream` for many containers → cpu% and memory MB by container id. */
  stats(ids: string[]): Promise<Map<string, { cpuPct: number; memMb: number }>>
  /** Pulls when missing locally. */
  ensureImage(image: string, onLine?: (text: string) => void): Promise<void>
  /** Makes sure the shared `canopy` bridge network exists. */
  ensureNetwork(name?: string): Promise<string>
}

export const CANOPY_LABEL = 'canopy.managed'
export const WORKTREE_LABEL = 'canopy.worktree'
export const SERVICE_LABEL = 'canopy.service'
export const DATABASE_LABEL = 'canopy.database'
export const CANOPY_NETWORK = 'canopy'
