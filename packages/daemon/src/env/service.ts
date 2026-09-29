/**
 * EnvironmentService — the one owner of per-worktree runtime state: what canopy.yaml declares,
 * which ports/DB forks/env a worktree has, the supervisor running its services, the current
 * provisioning run, and the resource history. Everything the routes and the worktree service
 * need about "the environment" goes through here; runners, adapters and stores stay behind
 * their interfaces.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

import type { Database } from 'better-sqlite3'
import { execa } from 'execa'

import {
  DEFAULT_WORKTREE_OPTIONS,
  applySettingsPatch,
  dbEnvKey,
  emptyEnvironment,
  interpolate,
  mergeOptions,
  parseCanopyYaml,
  renderWorktreePath,
  reportFor,
  serviceRuntime,
  servicePorts,
  type AppSettings,
  type AppSettingsPatch,
  type CanopyConfig,
  type CanopyYamlReport,
  type CreateWorktreeInput,
  type DbInstanceInfo,
  type DbSource,
  type EnvState,
  type HostInfo,
  type HostSample,
  type OpenInput,
  type Project,
  type ProjectEnvironmentPreview,
  type ProjectSettings,
  type ProjectSettingsPatch,
  type ProvisionRun,
  type ProvisionStepName,
  type ResourceSample,
  type ServiceInfo,
  type Worktree,
  type WorktreeEnvironment,
  type WorktreeOptions
} from '@canopy/shared'

import { projectHome, type DaemonConfig } from '../config'
import type { GitRunner } from '../git/exec'
import { ApiError, badRequest, conflict, notFound } from '../lib/errors'
import { newId, now } from '../lib/ids'
import type { ProjectsService } from '../projects/service'
import type { WorktreeRow, WorktreesService } from '../worktrees/service'
import { loadCanopyConfig } from './config/load'
import { resolveEnvironment, writeEnvFile, type ResolvedEnvironment } from './config/resolve'
import { scaffoldCanopyYaml } from './config/scaffold'
import type { PortAllocator } from './ports/allocator'
import { newRun, resumePoint, runPipeline } from './provision/pipeline'
import { detectCaches } from './provision/caches'
import { copyCandidates } from './provision/copy-files'
import { createSteps } from './provision/steps'
import type { ResourceSampler } from './resources/sampler'
import { MANAGED_BY } from './databases/via-canopyd'
import { CanopydSupervisor } from './services/canopyd-supervisor'
import { WorktreeSupervisor, type PreviousRecord, type Supervisor } from './services/supervisor'
import { loadAppSettings, saveAppSettings } from './settings/app-settings'
import { loadProjectSettings, saveProjectSettings } from './settings/project-settings'
import { sinkFor } from './logs/store'
import type { DbAdapter, DbContext, DockerHelper, EventBus, LogStore, ProvisionContext, ProvisionState, ServiceRunner } from './types'
import { supportsContainers, supportsRunControl, type Canopyd } from './worktree/canopyd'
import type { WorktreeBackend } from './worktree/backend'

/** How many numbers a database port may lose to `canopyd`'s registry before allocation gives up. */
const MAX_RESERVE_ATTEMPTS = 8

export interface EnvironmentDeps {
  db: Database
  config: DaemonConfig
  git: GitRunner
  projects: ProjectsService
  worktrees: WorktreesService
  logs: LogStore
  events: EventBus
  docker: DockerHelper
  backend: WorktreeBackend
  canopyd: Canopyd
  /** The environment every `canopyd` spawn runs with: the shared port registry and range. */
  canopydEnv?: () => Record<string, string>
  ports: PortAllocator
  databases: { adapterFor(name: DbInstanceInfo['adapter']): DbAdapter; all(): DbAdapter[] }
  runners: Record<'host' | 'docker' | 'compose', ServiceRunner>
  sampler: ResourceSampler
}

interface Runtime {
  id: string
  env: WorktreeEnvironment
  config: CanopyConfig | null
  resolved: ResolvedEnvironment | null
  supervisor: Supervisor | null
  /** Which implementation `supervisor` is, so a config that stops qualifying for canopyd gets the other one. */
  supervisorKind: 'canopyd' | 'daemon' | null
  abort: AbortController | null
  history: ResourceSample[]
  /** Serializes lifecycle operations per worktree. */
  chain: Promise<unknown>
  persistTimer: NodeJS.Timeout | null
  emitTimer: NodeJS.Timeout | null
}

interface EnvRow extends WorktreeRow {
  env_state: EnvState
  env_state_reason: string | null
  desired_state: 'running' | 'stopped'
  options_json: string | null
  env_json: string | null
  provisioned_at: number | null
}

interface DbRow {
  worktree_id: string
  name: string
  adapter: DbInstanceInfo['adapter']
  status: DbInstanceInfo['status']
  url: string | null
  forked_from: string
  forked_from_database: string | null
  forked_from_branch: string | null
  detail_json: string
  size_mb: number | null
  seeded_at: number | null
  error: string | null
}

const HISTORY = 90
const TICK_MS = 2000
/** How long graceful service stops may take on daemon shutdown before leftovers are reaped. */
const SHUTDOWN_GRACE_MS = 12_000
const LIVE_STATES: EnvState[] = ['running', 'degraded', 'starting']
/** A pipeline or lifecycle command owns the runtime; nothing else may rewrite its view of the config. */
const BUSY_STATES: EnvState[] = ['creating', 'provisioning', 'destroying']
const expandHome = (p: string): string => p.replace(/^~(?=$|\/)/, homedir())

/** Worktree state from desired state plus the worst service state. */
export function deriveState(desired: 'running' | 'stopped', services: ServiceInfo[]): EnvState {
  const active = services.filter((svc) => !svc.excluded)
  const liveish = active.filter((svc) => !['stopped', 'pending', 'exited', 'failed'].includes(svc.status))
  if (desired === 'stopped') return liveish.length > 0 ? 'stopping' : 'stopped'
  if (active.length === 0) return 'stopped'
  if (active.some((svc) => svc.status === 'unhealthy' || svc.status === 'exited' || svc.status === 'failed')) return 'degraded'
  if (active.some((svc) => svc.status === 'starting' || svc.status === 'restarting')) return 'starting'
  if (active.some((svc) => svc.status === 'healthy')) return 'running'
  return 'stopped'
}

export class EnvironmentService {
  private readonly runtimes = new Map<string, Runtime>()
  private ticker: NodeJS.Timeout | null = null
  private subscribers = 0
  private readonly steps

  constructor(private readonly deps: EnvironmentDeps) {
    this.steps = createSteps({
      git: deps.git,
      backend: deps.backend,
      canopyd: deps.canopyd,
      ports: deps.ports,
      databases: deps.databases,
      dbContext: (ctx, env) => this.dbContext(ctx.worktreeId, ctx.worktreeName, ctx.branch ?? null, ctx.worktreePath, ctx.project, env),
      toolUsable: (ctx) => this.toolUsable(ctx.settings.worktree.tool),
      homeConfig: (ctx) => this.homeConfig(ctx.project),
      dbContextFor: (id) => this.dbContextFor(id),
      onDatabase: (ctx, db) => this.recordDatabase(ctx.worktreeId, db),
      resolve: (ctx) => this.resolveFor(ctx.worktreeId, ctx.config, ctx.options, ctx.settings, ctx.state.databases),
      writeEnv: (ctx, resolved) => this.writeEnv(ctx.worktreeId, resolved),
      startServices: (ctx) => this.startFromPipeline(ctx.worktreeId)
    })
    this.load()
  }

  // ---------- persistence ----------

  private get db(): Database {
    return this.deps.db
  }

  private load(): void {
    const rows = this.db.prepare(`SELECT * FROM worktrees WHERE env_json IS NOT NULL OR env_state != 'none'`).all() as EnvRow[]
    for (const row of rows) {
      let env: WorktreeEnvironment
      try {
        env = row.env_json ? (JSON.parse(row.env_json) as WorktreeEnvironment) : emptyEnvironment(false)
      } catch {
        env = emptyEnvironment(false)
      }
      // Nothing is running right after boot; reconcile() restarts what was desired.
      env.services = env.services.map((svc) => ({ ...svc, status: 'stopped', pid: undefined, containerId: undefined, cpuPct: undefined, memMb: undefined, startedAt: null }))
      env.desired = row.desired_state
      if (env.provisioning?.status === 'running') {
        env.provisioning = {
          ...env.provisioning,
          status: 'failed',
          finishedAt: now(),
          steps: env.provisioning.steps.map((step) => (step.status === 'active' ? { ...step, status: 'failed', error: 'daemon restarted during this step' } : step))
        }
        env.state = 'error'
        env.stateReason = 'daemon restarted while provisioning — retry from the failed step'
      } else if (row.env_state === 'destroying') {
        env.state = 'destroying'
      } else if (env.state !== 'none' && env.state !== 'error') {
        env.state = 'stopped'
      }
      env.databases = this.loadDatabases(row.id, env.databases)
      env.ports = this.deps.ports.allocated(row.id)
      env.startedAt = null
      this.runtimes.set(row.id, this.newRuntime(row.id, env))
    }
  }

  private loadDatabases(worktreeId: string, fallback: DbInstanceInfo[]): DbInstanceInfo[] {
    const rows = this.db.prepare('SELECT * FROM db_instances WHERE worktree_id = ? ORDER BY name').all(worktreeId) as DbRow[]
    if (rows.length === 0) return fallback
    return rows.map((row) => ({
      name: row.name,
      adapter: row.adapter,
      status: row.status === 'forking' ? 'error' : row.status,
      connectionUrl: row.url,
      envKey: fallback.find((db) => db.name === row.name)?.envKey ?? dbEnvKey(row.name, {}),
      forkedFrom: row.forked_from,
      // `?? null` rather than a straight read: a database that missed the lineage migration
      // answers `undefined` for columns SELECT * never returned.
      forkedFromDatabase: row.forked_from_database ?? null,
      forkedFromBranch: row.forked_from_branch ?? null,
      sizeMb: row.size_mb,
      seededAt: row.seeded_at,
      detail: JSON.parse(row.detail_json) as Record<string, string>,
      error: row.status === 'forking' ? 'daemon restarted while forking' : row.error
    }))
  }

  private newRuntime(id: string, env: WorktreeEnvironment): Runtime {
    return { id, env, config: null, resolved: null, supervisor: null, supervisorKind: null, abort: null, history: [], chain: Promise.resolve(), persistTimer: null, emitTimer: null }
  }

  private persistSoon(rt: Runtime): void {
    if (rt.persistTimer) return
    rt.persistTimer = setTimeout(() => {
      rt.persistTimer = null
      this.persist(rt)
    }, 150)
  }

  private persist(rt: Runtime): void {
    const { env } = rt
    const exists = this.db.prepare('SELECT 1 FROM worktrees WHERE id = ?').get(rt.id)
    if (!exists) return
    this.db
      .prepare('UPDATE worktrees SET env_state = ?, env_state_reason = ?, desired_state = ?, options_json = ?, env_json = ?, provisioned_at = ?, updated_at = ? WHERE id = ?')
      .run(env.state, env.stateReason, env.desired, JSON.stringify(env.options), JSON.stringify(env), env.provisionedAt, now(), rt.id)
    if (env.provisioning) {
      this.db
        .prepare(
          `INSERT INTO provision_runs (id, worktree_id, status, steps_json, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET status = excluded.status, steps_json = excluded.steps_json, finished_at = excluded.finished_at`
        )
        .run(env.provisioning.id, rt.id, env.provisioning.status, JSON.stringify(env.provisioning.steps), env.provisioning.startedAt, env.provisioning.finishedAt)
    }
    if (rt.supervisor) this.persistServiceRecords(rt.id, rt.supervisor.records())
  }

  private persistServiceRecords(worktreeId: string, records: PreviousRecord[]): void {
    const upsert = this.db.prepare(
      `INSERT INTO service_state (worktree_id, name, runtime, pid, pid_start, container_id, compose_project, restarts, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(worktree_id, name) DO UPDATE SET runtime = excluded.runtime, pid = excluded.pid, pid_start = excluded.pid_start, container_id = excluded.container_id, compose_project = excluded.compose_project, restarts = excluded.restarts, updated_at = excluded.updated_at`
    )
    this.db.transaction(() => {
      for (const r of records) upsert.run(worktreeId, r.name, r.runtime, r.pid, r.pidStart, r.containerId, r.composeProject, r.restarts, now())
    })()
  }

  private recordDatabase(worktreeId: string, db: DbInstanceInfo): void {
    this.db
      .prepare(
        `INSERT INTO db_instances (worktree_id, name, adapter, status, url, forked_from, forked_from_database, forked_from_branch, detail_json, size_mb, seeded_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(worktree_id, name) DO UPDATE SET adapter = excluded.adapter, status = excluded.status, url = excluded.url, forked_from = excluded.forked_from, forked_from_database = excluded.forked_from_database, forked_from_branch = excluded.forked_from_branch, detail_json = excluded.detail_json, size_mb = excluded.size_mb, seeded_at = excluded.seeded_at, error = excluded.error`
      )
      .run(worktreeId, db.name, db.adapter, db.status, db.connectionUrl, db.forkedFrom, db.forkedFromDatabase, db.forkedFromBranch, JSON.stringify(db.detail), db.sizeMb, db.seededAt, db.error)
    const rt = this.runtimes.get(worktreeId)
    if (!rt) return
    const others = rt.env.databases.filter((d) => d.name !== db.name)
    this.update(rt, { databases: [...others, db].sort((a, b) => a.name.localeCompare(b.name)) })
  }

  // ---------- snapshots & events ----------

  private runtime(worktreeId: string): Runtime {
    const existing = this.runtimes.get(worktreeId)
    if (existing) return existing
    const row = this.deps.worktrees.row(worktreeId)
    const project = this.deps.projects.get(row.project_id)
    const loaded = loadCanopyConfig(row.path, project.path, this.home(project))
    const rt = this.newRuntime(worktreeId, emptyEnvironment(loaded.config !== null, loaded.report.errors))
    rt.env.options = this.defaultOptions(project)
    this.runtimes.set(worktreeId, rt)
    return rt
  }

  private update(rt: Runtime, patch: Partial<WorktreeEnvironment>): void {
    rt.env = { ...rt.env, ...patch }
    this.persistSoon(rt)
    if (rt.emitTimer) return
    rt.emitTimer = setTimeout(() => {
      rt.emitTimer = null
      this.deps.events.emit({ type: 'environment', worktreeId: rt.id, environment: rt.env })
    }, 25)
  }

  /**
   * The environment attached to every Worktree on the wire.
   *
   * `configured` is re-read here rather than trusted from the stored row: a canopy.yaml
   * written outside Canopy (by hand, by an agent, by a merge) must light up the Start button
   * without a daemon restart, and one that was deleted must stop claiming the worktree is
   * runnable. The load is mtime-cached, so the polling dashboard costs a stat, not a parse.
   */
  environmentOf(worktreeId: string): WorktreeEnvironment {
    const rt = this.runtimes.get(worktreeId) ?? this.runtime(worktreeId)
    this.refreshConfigured(rt)
    return rt.env
  }

  /** Re-checks the config on disk. Skipped mid-run: the pipeline is using the config it loaded. */
  private refreshConfigured(rt: Runtime): void {
    if (BUSY_STATES.includes(rt.env.state)) return
    const row = this.tryRow(rt.id)
    if (!row) return
    const project = this.deps.projects.get(row.project_id)
    const loaded = loadCanopyConfig(row.path, project.path, this.home(project))
    const configured = loaded.config !== null
    const errors = loaded.report.errors
    if (configured === rt.env.configured && errors.join('\u0000') === rt.env.configErrors.join('\u0000')) return
    this.update(rt, { configured, configErrors: errors })
  }

  /** Called by the events route so host samples are only produced while someone listens. */
  subscribe(listener: Parameters<EventBus['subscribe']>[0]): () => void {
    this.subscribers += 1
    const off = this.deps.events.subscribe(listener)
    return () => {
      this.subscribers -= 1
      off()
    }
  }

  // ---------- settings & config ----------

  /** `~/.canopy/<project>/` — where a repo that carries no canopy.yaml can keep one. */
  private home(project: { name: string }): string {
    return projectHome(this.deps.config.home, project.name)
  }

  /**
   * The canopy.yaml in the project's Canopy home, when there is one. `canopyd` looks for its
   * out-of-repo file somewhere else, so it is told about this one; it still prefers a file the
   * repository carries, exactly as `loadCanopyConfig` does.
   */
  private homeConfig(project: { name: string }): string | undefined {
    const home = this.home(project)
    return ['canopy.yaml', 'canopy.yml'].map((name) => join(home, name)).find((path) => existsSync(path))
  }

  /** Whether this project's worktrees go through `canopyd`: the setting allows it and it is installed. */
  private async toolUsable(setting: boolean): Promise<boolean> {
    return setting && (await this.deps.backend.info()).available
  }

  /**
   * The key a worktree's ports are filed under in `canopyd`'s registry: its branch, or its
   * name when it is detached. The ports step, database reservations and teardown all use this,
   * so a release finds what an allocation filed.
   */
  private portKey(row: { branch: string | null; name: string }): string {
    return row.branch ?? row.name
  }

  /**
   * A database fork's port. The daemon picks it — `canopyd` has no notion of these containers —
   * and then reserves it in `canopyd`'s registry, which is where every service port comes
   * from; otherwise a service could later be handed the number a stopped fork is holding. A
   * number the registry already gave someone else is dropped and the walk goes on.
   */
  private async allocateDbPort(worktreeId: string, name: string, key: string, project: { id: string; path: string }): Promise<number> {
    const seedKey = `${project.id}/${worktreeId}/${name}`
    if (!(await this.toolUsable(this.settings(project.id).worktree.tool))) return this.deps.ports.allocate(worktreeId, name, { seedKey })
    const avoid = new Set<number>()
    for (let attempt = 0; attempt < MAX_RESERVE_ATTEMPTS; attempt += 1) {
      const port = await this.deps.ports.allocate(worktreeId, name, { seedKey, avoid })
      try {
        await this.deps.canopyd.reserve({ cwd: project.path, branch: key, ports: { [name]: port } })
        return port
      } catch (error) {
        if (!(error instanceof ApiError && error.code === 'port_in_use')) throw error
        this.deps.ports.release(worktreeId, name)
        avoid.add(port)
      }
    }
    throw conflict('no_free_port', `no port for ${name} that canopyd's registry does not already hold (tried ${[...avoid].join(', ')})`)
  }

  /**
   * Hands a worktree's rows in `canopyd`'s registry back. Best effort, like the rest of a
   * teardown: `canopyd rm` does it too, but a worktree removed with plain git, reaped after an
   * outside removal, or detached (which `rm` addresses by path and cannot release by branch)
   * would otherwise hold its numbers forever.
   */
  private async releaseToolPorts(worktreeId: string, row: WorktreeRow | undefined, project: { id: string; path: string } | null): Promise<void> {
    if (!row || !project || !(await this.toolUsable(this.settings(project.id).worktree.tool))) return
    try {
      await this.deps.canopyd.releasePorts({ cwd: project.path, branch: this.portKey(row) })
    } catch (error) {
      sinkFor(this.deps.logs, worktreeId, 'provision').err(`release ports: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  settings(projectId: string): ProjectSettings {
    const project = this.deps.projects.get(projectId)
    return loadProjectSettings(this.db, projectId, project.ecosystems)
  }

  updateSettings(projectId: string, patch: ProjectSettingsPatch): ProjectSettings {
    const project = this.deps.projects.get(projectId)
    const next = applySettingsPatch(this.settings(projectId), patch)
    saveProjectSettings(this.db, projectId, next)
    this.deps.events.emit({ type: 'project-changed', projectId })
    return next
  }

  appSettings(): AppSettings {
    return loadAppSettings(this.deps.config.home)
  }

  updateAppSettings(patch: AppSettingsPatch): AppSettings {
    const current = this.appSettings()
    const next: AppSettings = {
      editor: patch.editor ?? current.editor,
      terminal: patch.terminal ?? current.terminal,
      diff: { ...current.diff, ...(patch.diff ?? {}) },
      ports: patch.ports ?? current.ports
    }
    if (next.ports.from >= next.ports.to) throw badRequest('bad_port_range', 'the port range must be ascending')
    saveAppSettings(this.deps.config.home, next)
    return next
  }

  projectConfig(project: Project): { raw: string | null; path: string; report: CanopyYamlReport } {
    const loaded = loadCanopyConfig(project.path, undefined, this.home(project))
    return { raw: loaded.raw, path: loaded.path ?? join(project.path, 'canopy.yaml'), report: loaded.report }
  }

  writeProjectConfig(project: Project, raw: string): { raw: string; report: CanopyYamlReport } {
    const parsed = parseCanopyYaml(raw)
    if (!parsed.config) throw badRequest('invalid_canopy_yaml', 'canopy.yaml has errors', { errors: parsed.errors, warnings: parsed.warnings })
    const target = loadCanopyConfig(project.path, undefined, this.home(project)).path ?? join(project.path, 'canopy.yaml')
    writeFileSync(target, raw.endsWith('\n') ? raw : raw + '\n')
    this.deps.projects.rememberConfig(project.id, raw)
    this.deps.events.emit({ type: 'project-changed', projectId: project.id })
    // Worktrees inherit the project file when they have none of their own: refresh their view.
    for (const rt of this.runtimes.values()) {
      const row = this.tryRow(rt.id)
      if (row?.project_id !== project.id) continue
      const loaded = loadCanopyConfig(row.path, project.path, this.home(project))
      this.update(rt, { configured: loaded.config !== null, configErrors: loaded.report.errors })
    }
    return { raw, report: reportFor(parsed) }
  }

  async scaffoldConfig(project: Project): Promise<{ raw: string; report: CanopyYamlReport }> {
    const raw = await scaffoldCanopyYaml(project.path, { ecosystems: project.ecosystems, compose: project.compose })
    return { raw, report: reportFor(parseCanopyYaml(raw)) }
  }

  async preview(project: Project): Promise<ProjectEnvironmentPreview> {
    const loaded = loadCanopyConfig(project.path, undefined, this.home(project))
    const settings = this.settings(project.id)
    const config = loaded.config
    const yamlEnv = config ? { ...config.defaults.env, ...config.env } : {}
    return {
      report: loaded.report,
      services: config
        ? Object.entries(config.services).map(([name, spec]) => ({
            name,
            runtime: serviceRuntime(spec, config),
            command: spec.run ?? `docker compose -f ${spec.compose?.file ?? 'docker-compose.yml'} up`,
            ports: servicePorts(spec),
            autostart: spec.autostart,
            dependsOn: spec.depends_on,
            description: spec.description ?? null
          }))
        : [],
      ports: config ? Object.entries(config.ports).map(([name, spec]) => ({ name, preferred: spec.preferred ?? null })) : [],
      databases: config ? Object.entries(config.databases).map(([name, spec]) => ({ name, adapter: spec.adapter, envKey: dbEnvKey(name, spec) })) : [],
      setup: config ? config.setup.map((step) => (typeof step === 'string' ? step : step.run)) : [],
      env: Object.entries(yamlEnv).map(([key, value]) => ({ key, value, source: 'yaml' as const, secret: /(key|token|secret|password)/i.test(key) })),
      envFile: config ? (config.env_file === false ? null : config.env_file) : null,
      detectedCaches: detectCaches(project.path, settings.caches.rules),
      detectedCopyCandidates: await copyCandidates(this.deps.git, project.path, settings.copyFiles).catch(() => [])
    }
  }

  async hostInfo(): Promise<HostInfo> {
    const [docker, canopyd] = await Promise.all([this.deps.docker.info(), this.deps.backend.info()])
    const app = this.appSettings()
    // Hooks in .config/wt.toml call `canopy …`; when it is not on PATH, tell users the absolute invocation instead.
    const which = await execa('sh', ['-c', 'command -v canopy'], { reject: false })
    const canopyCommand = which.exitCode === 0 ? 'canopy' : `node ${new URL('../../bin/canopy.mjs', import.meta.url).pathname}`
    const os = await import('node:os')
    return {
      platform: process.platform,
      arch: process.arch,
      hostname: hostname(),
      cores: os.cpus().length,
      memMb: Math.round(os.totalmem() / (1024 * 1024)),
      docker: { available: docker.available, version: docker.version, path: docker.path },
      canopyd: { available: canopyd.available, version: canopyd.version, path: canopyd.path },
      worktreeRoot: this.deps.config.worktreeRoot,
      dataRoot: this.deps.config.dataRoot,
      portRange: [app.ports.from, app.ports.to],
      canopyCommand
    }
  }

  // ---------- creation, adoption, provisioning ----------

  private defaultOptions(project: Project): WorktreeOptions {
    const settings = this.settings(project.id)
    return mergeOptions(DEFAULT_WORKTREE_OPTIONS, { dbSource: settings.defaults.dbSource, runtime: settings.defaults.runtime === 'per-service' ? null : settings.defaults.runtime })
  }

  /** Path a new worktree of this project will get, from the project's path template. */
  worktreePathFor(project: Project, name: string, branch: string): string {
    const settings = this.settings(project.id)
    return expandHome(renderWorktreePath(settings.worktree.worktreePath, { root: this.deps.config.worktreeRoot, repo: project.name, repoPath: project.path, name, branch }))
  }

  /**
   * Registers the row immediately (state `creating`) and runs the whole pipeline in the
   * background, starting with `wt switch` / `git worktree add`. Returns once the row exists.
   */
  createAndProvision(project: Project, input: CreateWorktreeInput): WorktreeRow {
    const path = this.worktreePathFor(project, input.name, input.branch.name)
    if (existsSync(path)) throw conflict('worktree_exists', `${path} already exists`)
    const clash = this.db.prepare('SELECT id FROM worktrees WHERE path = ? OR (project_id = ? AND name = ?)').get(path, project.id, input.name)
    if (clash) throw conflict('worktree_exists', `a worktree named ${input.name} already exists`)
    const settings = this.settings(project.id)
    const options = mergeOptions(this.defaultOptions(project), input.options)
    const autoStart = input.autoStart ?? settings.defaults.autoStart
    const id = newId()
    const at = now()
    this.db
      .prepare(
        `INSERT INTO worktrees (id, project_id, name, path, branch, base_branch, is_main, managed, missing, created_at, updated_at, env_state, desired_state, options_json)
         VALUES (?, ?, ?, ?, ?, ?, 0, 1, 0, ?, ?, 'creating', 'stopped', ?)`
      )
      .run(id, project.id, input.name, path, input.branch.name, input.branch.mode === 'new' ? input.branch.base : project.defaultBase, at, at, JSON.stringify(options))
    const loaded = loadCanopyConfig(project.path, undefined, this.home(project))
    const rt = this.newRuntime(id, { ...emptyEnvironment(loaded.config !== null, loaded.report.errors), state: 'creating', options })
    this.runtimes.set(id, rt)
    this.deps.events.emit({ type: 'worktrees-changed', projectId: project.id })
    void this.enqueue(rt, () => this.runProvision(rt, { from: 'create-worktree', autoStart, provision: input.provision ?? true, branchSpec: input.branch }))
    return this.deps.worktrees.row(id)
  }

  /** A worktree that exists on disk (made by `wt switch` or discovered) gets provisioned. */
  async adopt(path: string, autoStart?: boolean): Promise<WorktreeRow> {
    await this.deps.worktrees.listAll()
    const row = this.deps.worktrees.rowByPath(path)
    if (!row) throw badRequest('unknown_worktree', `${path} is not a worktree of a registered project`)
    const rt = this.runtime(row.id)
    if (rt.env.state === 'provisioning' || rt.env.state === 'creating') return row
    await this.provision(row.id, { from: 'copy-files', autoStart })
    return row
  }

  /** Public provision entry: returns the run once it has started (steps continue in the background). */
  async provision(worktreeId: string, input: { from?: ProvisionStepName; options?: Partial<WorktreeOptions>; autoStart?: boolean }): Promise<ProvisionRun> {
    const rt = this.runtime(worktreeId)
    if (rt.env.state === 'provisioning' || rt.env.state === 'creating') throw conflict('already_provisioning', 'a provisioning run is already in progress')
    if (rt.env.state === 'destroying') throw conflict('destroying', 'the worktree is being destroyed')
    const row = this.deps.worktrees.row(worktreeId)
    const project = this.deps.projects.get(row.project_id)
    if (input.options) this.update(rt, { options: mergeOptions(rt.env.options, input.options) })
    const from = input.from ?? resumePoint(rt.env.provisioning)
    const autoStart = input.autoStart ?? this.settings(project.id).defaults.autoStart
    const started = new Promise<ProvisionRun>((resolve) => {
      void this.enqueue(rt, () => this.runProvision(rt, { from, autoStart, provision: true, branchSpec: null, onStarted: resolve }))
    })
    return started
  }

  private async runProvision(rt: Runtime, opts: { from: ProvisionStepName; autoStart: boolean; provision: boolean; branchSpec: CreateWorktreeInput['branch'] | null; onStarted?: (run: ProvisionRun) => void }): Promise<void> {
    const row = this.deps.worktrees.row(rt.id)
    const project = this.deps.projects.get(row.project_id)
    const settings = this.settings(project.id)
    const loaded = loadCanopyConfig(existsSync(row.path) ? row.path : project.path, project.path, this.home(project))
    const config = opts.provision ? loaded.config : null
    rt.config = config
    const wasLive = LIVE_STATES.includes(rt.env.state)
    if (wasLive && rt.supervisor) await rt.supervisor.stop()
    const abort = new AbortController()
    rt.abort = abort
    const sourcePath = typeof rt.env.options.cacheSource === 'object' ? (this.tryRow(rt.env.options.cacheSource.fromWorktree)?.path ?? project.path) : project.path
    const dataDir = this.dataDir(rt.id)
    mkdirSync(dataDir, { recursive: true })
    const state: ProvisionState = {
      copiedFiles: [...rt.env.copiedFiles],
      caches: [...rt.env.caches],
      ports: this.deps.ports.allocated(rt.id),
      databases: [...rt.env.databases],
      env: [...rt.env.env],
      envFile: rt.env.envFile,
      reinstall: []
    }
    const ctx: ProvisionContext = {
      worktreeId: rt.id,
      worktreeName: row.name,
      project: { id: project.id, name: project.name, path: project.path, defaultBase: project.defaultBase, ecosystems: project.ecosystems },
      settings,
      options: rt.env.options,
      config,
      worktreePath: row.path,
      sourcePath,
      branch: row.branch,
      branchSpec: opts.branchSpec,
      autoStart: opts.autoStart,
      dataDir,
      logs: sinkFor(this.deps.logs, rt.id, 'provision'),
      signal: abort.signal,
      state
    }
    const run = newRun(opts.from, rt.env.provisioning)
    this.update(rt, {
      state: existsSync(row.path) ? 'provisioning' : 'creating',
      stateReason: null,
      configured: loaded.config !== null,
      configErrors: loaded.report.errors,
      provisioning: run
    })
    opts.onStarted?.(run)
    ctx.logs.sys(`provisioning ${row.name} from ${opts.from}${config ? '' : ' (no canopy.yaml: worktree, files and caches only)'}`)

    const outcome = await runPipeline(this.steps, ctx, run, (current) => {
      const patch: Partial<WorktreeEnvironment> = { provisioning: current }
      if (current.steps.find((s) => s.name === 'create-worktree')?.status === 'done' && rt.env.state === 'creating') {
        patch.state = 'provisioning'
        this.deps.events.emit({ type: 'worktrees-changed', projectId: project.id })
      }
      this.update(rt, patch)
    })
    rt.abort = null
    const services = rt.supervisor?.snapshot() ?? this.describeServices(rt)
    const finalPatch: Partial<WorktreeEnvironment> = {
      provisioning: outcome.run,
      copiedFiles: state.copiedFiles,
      caches: state.caches,
      ports: state.ports,
      databases: state.databases.length > 0 ? state.databases : rt.env.databases,
      env: state.env,
      envFile: state.envFile,
      services
    }
    if (outcome.failedStep) {
      this.update(rt, { ...finalPatch, state: outcome.error === 'cancelled' ? rt.env.state : 'error', stateReason: `${outcome.failedStep}: ${outcome.error}` })
      return
    }
    if (!config) {
      this.update(rt, { ...finalPatch, state: 'none', stateReason: null, provisionedAt: now() })
      return
    }
    const desired = opts.autoStart ? 'running' : 'stopped'
    this.update(rt, { ...finalPatch, desired, provisionedAt: now(), state: deriveState(desired, services), stateReason: null })
  }

  /** Cheap ServiceInfo rows for a worktree that has never started (or after a re-provision). */
  private describeServices(rt: Runtime): ServiceInfo[] {
    const resolved = rt.resolved
    if (!resolved) return rt.env.services
    const previous = new Map(rt.env.services.map((svc) => [svc.name, svc]))
    return resolved.services.map((svc) => ({
      name: svc.name,
      runtime: svc.runtime,
      command: svc.command,
      cwd: svc.spec.cwd,
      ports: svc.ports,
      status: previous.get(svc.name)?.status === 'healthy' ? 'healthy' : 'stopped',
      restarts: previous.get(svc.name)?.restarts ?? 0,
      excluded: resolved.excluded.has(svc.name),
      autostart: svc.spec.autostart,
      health: svc.spec.health ? (svc.spec.health.http ? 'http' : svc.spec.health.tcp !== undefined ? 'tcp' : 'cmd') : 'none',
      dependsOn: svc.spec.depends_on,
      startedAt: previous.get(svc.name)?.startedAt ?? null,
      exitCode: null,
      lastError: null
    }))
  }

  private resolveFor(worktreeId: string, config: CanopyConfig | null, options: WorktreeOptions, settings: ProjectSettings, databases: DbInstanceInfo[]): ResolvedEnvironment {
    const rt = this.runtime(worktreeId)
    const row = this.deps.worktrees.row(worktreeId)
    const project = this.deps.projects.get(row.project_id)
    const resolved = resolveEnvironment({
      config: config ?? { version: 1, defaults: { runtime: 'host', env: {} }, env: {}, ports: {}, databases: {}, setup: [], services: {}, env_file: false },
      options,
      settings,
      ports: this.deps.ports.allocated(worktreeId),
      databases: databases.map((db) => ({ name: db.name, url: db.connectionUrl, envKey: db.envKey, detail: db.detail })),
      worktree: { id: worktreeId, name: row.name, path: row.path, branch: row.branch },
      project: { id: project.id, name: project.name }
    })
    rt.resolved = resolved
    return resolved
  }

  private async startFromPipeline(worktreeId: string): Promise<{ started: string[] }> {
    const rt = this.runtime(worktreeId)
    const started = await this.startNow(rt)
    return { started }
  }

  // ---------- lifecycle ----------

  private enqueue<T>(rt: Runtime, work: () => Promise<T>): Promise<T> {
    const next = rt.chain.then(work, work)
    rt.chain = next.catch(() => undefined)
    return next
  }

  private ensureResolved(rt: Runtime): ResolvedEnvironment {
    const row = this.deps.worktrees.row(rt.id)
    const project = this.deps.projects.get(row.project_id)
    const loaded = loadCanopyConfig(row.path, project.path, this.home(project))
    if (!loaded.config) throw badRequest('no_canopy_yaml', loaded.report.errors[0] ?? 'this project has no valid canopy.yaml')
    rt.config = loaded.config
    return this.resolveFor(rt.id, loaded.config, rt.env.options, this.settings(project.id), rt.env.databases)
  }

  /**
   * Whether `canopyd run` can supervise this worktree, or why the in-process supervisor has to.
   *
   * canopyd reads `canopy.yaml` itself, so it has to be able to find the same file this daemon
   * resolved, address the worktree by branch, and drive every runtime in it. `${db.…}` it resolves
   * only against forks it made, so a fork still held in-process (made before canopyd drove that
   * engine, or a Redis on the host) keeps the worktree here. A worktree-level value reaches it as
   * an override; a command or a service's own `env:` that uses one does not.
   */
  private async canopydCanRun(rt: Runtime): Promise<{ ok: true; branch: string } | { ok: false; reason: string }> {
    const sees = await this.canopydSees(rt.id)
    if (!sees.ok) return sees
    const loaded = sees.loaded
    const row = this.deps.worktrees.row(rt.id)
    const services = rt.resolved?.services ?? []
    const contained = services.find((svc) => svc.runtime !== 'host' && !rt.resolved?.excluded.has(svc.name))
    if (contained && !supportsContainers(await this.deps.canopyd.version())) {
      return { ok: false, reason: `${contained.name} runs on ${contained.runtime}, which needs canopyd 0.4.0` }
    }
    // canopyd resolves `${db.…}` only against forks it made itself.
    const foreignFork = rt.env.databases.find((db) => db.detail[MANAGED_BY] !== 'canopyd')
    if (foreignFork && JSON.stringify(loaded.config?.services ?? {}).includes('${db.')) {
      return { ok: false, reason: `a service refers to \${db.…} and ${foreignFork.name} was not forked by canopyd` }
    }
    return { ok: true, branch: row.branch ?? sees.branch }
  }

  /**
   * Whether canopyd, run in this worktree, is looking at the same thing this daemon is: a recent
   * enough binary, a worktree it can address, and the `canopy.yaml` this daemon resolved.
   */
  private async canopydSees(worktreeId: string): Promise<{ ok: true; branch: string; loaded: ReturnType<typeof loadCanopyConfig> } | { ok: false; reason: string }> {
    const row = this.deps.worktrees.row(worktreeId)
    const project = this.deps.projects.get(row.project_id)
    if (!this.settings(project.id).worktree.tool) return { ok: false, reason: 'the project has canopyd turned off' }
    const tool = await this.deps.backend.info()
    if (!tool.available) return { ok: false, reason: 'canopyd is not installed' }
    if (!supportsRunControl(tool.version)) return { ok: false, reason: `canopyd ${tool.version ?? '?'} is older than 0.2.0` }
    if (!row.branch) return { ok: false, reason: 'the worktree is on a detached HEAD' }
    const loaded = loadCanopyConfig(row.path, project.path, this.home(project))
    if (!loaded.config || !loaded.path) return { ok: false, reason: 'there is no canopy.yaml' }
    const inCheckout = loaded.path.startsWith(`${row.path}/`) || loaded.path.startsWith(`${project.path}/`)
    if (!inCheckout) return { ok: false, reason: 'canopy.yaml lives outside the repository' }
    return { ok: true, branch: row.branch, loaded }
  }

  /**
   * Writes the worktree's env file. canopyd writes it when it can see the worktree, with every
   * value this daemon resolved layered on top — so the file holds the fork URLs and settings
   * canopyd knows nothing about, in canopyd's format, and the two cannot drift.
   */
  private async writeEnv(worktreeId: string, resolved: ResolvedEnvironment): Promise<void> {
    if (!resolved.envFile) return
    const sees = await this.canopydSees(worktreeId)
    if (sees.ok) {
      await this.deps.canopyd.writeEnv({ cwd: this.deps.worktrees.row(worktreeId).path, branch: sees.branch, env: resolved.envMap })
      return
    }
    writeEnvFile(resolved.envFile, resolved.env)
  }

  private async supervisorFor(rt: Runtime): Promise<Supervisor> {
    const verdict = await this.canopydCanRun(rt)
    const kind = verdict.ok ? 'canopyd' : 'daemon'
    if (rt.supervisor && rt.supervisorKind === kind) return rt.supervisor
    if (rt.supervisor) {
      // The config changed what it needs. Nothing moves while services are up: whoever started
      // them is the only one that can stop them cleanly.
      if (rt.supervisor.handles().size > 0) return rt.supervisor
      await rt.supervisor.dispose().catch(() => undefined)
    }
    const row = this.deps.worktrees.row(rt.id)
    const project = this.deps.projects.get(row.project_id)
    const ctx = { worktreeId: rt.id, worktreePath: row.path, projectName: project.name, dataDir: this.dataDir(rt.id), logs: sinkFor(this.deps.logs, rt.id, 'supervisor') }
    const onChange = (services: ServiceInfo[]): void => {
      const state = rt.env.state === 'provisioning' || rt.env.state === 'creating' || rt.env.state === 'destroying' || rt.env.state === 'error' ? rt.env.state : deriveState(rt.env.desired, services)
      const startedAt = LIVE_STATES.includes(state) ? (rt.env.startedAt ?? now()) : null
      this.update(rt, { services, state, startedAt })
    }
    let supervisor: Supervisor
    if (verdict.ok) {
      supervisor = new CanopydSupervisor({
        branch: verdict.branch,
        ctx,
        sinkFor: (service) => sinkFor(this.deps.logs, rt.id, service),
        onChange,
        // Everything canopyd would not arrive at from canopy.yaml alone: fork URLs, project and
        // per-worktree settings, and this daemon's own facts about the worktree.
        overrides: () => Object.fromEntries((rt.resolved?.env ?? []).filter((v) => v.source !== 'yaml').map((v) => [v.key, v.value])),
        toolEnv: this.deps.canopydEnv
      })
    } else {
      ctx.logs.sys(`services are supervised by the daemon: ${verdict.reason}`)
      supervisor = new WorktreeSupervisor({
        runners: this.deps.runners,
        ctx,
        logs: this.deps.logs,
        sinkFor: (service) => sinkFor(this.deps.logs, rt.id, service),
        interpolate: (text) => (rt.resolved ? interpolate(text, rt.resolved.scope) : text),
        onChange
      })
    }
    rt.supervisor = supervisor
    rt.supervisorKind = kind
    return supervisor
  }

  private async startNow(rt: Runtime): Promise<string[]> {
    const resolved = this.ensureResolved(rt)
    const supervisor = await this.supervisorFor(rt)
    supervisor.configure(resolved.services, resolved.excluded)
    this.update(rt, { desired: 'running', state: 'starting', stateReason: null, startedAt: now(), services: supervisor.snapshot() })
    this.ensureTicker()
    await supervisor.start()
    const services = supervisor.snapshot()
    this.update(rt, { services, state: deriveState('running', services) })
    return services.filter((svc) => !svc.excluded && svc.autostart).map((svc) => svc.name)
  }

  async start(worktreeId: string): Promise<void> {
    const rt = this.runtime(worktreeId)
    if (rt.env.state === 'none') {
      await this.provision(worktreeId, { autoStart: true })
      return
    }
    if (rt.env.state === 'provisioning' || rt.env.state === 'creating') throw conflict('busy', 'provisioning is in progress')
    await this.enqueue(rt, async () => {
      await this.startNow(rt)
    })
  }

  async stop(worktreeId: string): Promise<void> {
    const rt = this.runtime(worktreeId)
    await this.enqueue(rt, async () => {
      if (!rt.supervisor) {
        this.update(rt, { desired: 'stopped', state: rt.env.state === 'none' ? 'none' : 'stopped', startedAt: null })
        return
      }
      this.update(rt, { desired: 'stopped', state: 'stopping' })
      await rt.supervisor.stop()
      const services = rt.supervisor.snapshot()
      this.update(rt, { services, state: 'stopped', startedAt: null, stateReason: null })
    })
  }

  async restart(worktreeId: string): Promise<void> {
    await this.stop(worktreeId)
    await this.start(worktreeId)
  }

  async serviceAction(worktreeId: string, service: string, action: 'start' | 'stop' | 'restart'): Promise<void> {
    const rt = this.runtime(worktreeId)
    await this.enqueue(rt, async () => {
      const resolved = rt.resolved ?? this.ensureResolved(rt)
      if (!resolved.services.some((svc) => svc.name === service)) throw notFound('service', service)
      const fresh = !rt.supervisor
      const supervisor = await this.supervisorFor(rt)
      if (rt.env.services.length === 0 || fresh) supervisor.configure(resolved.services, resolved.excluded)
      if (action === 'start') {
        if (rt.env.desired !== 'running') this.update(rt, { desired: 'running', startedAt: rt.env.startedAt ?? now() })
        this.ensureTicker()
        await supervisor.start([service])
      } else if (action === 'stop') await supervisor.stop([service])
      else await supervisor.restart(service)
      const services = supervisor.snapshot()
      this.update(rt, { services, state: deriveState(rt.env.desired, services) })
    })
  }

  // ---------- databases & env ----------

  private dataDir(worktreeId: string): string {
    return join(this.deps.config.dataRoot, worktreeId)
  }

  private dbContext(worktreeId: string, worktreeName: string, worktreeBranch: string | null, worktreePath: string, project: { id: string; name: string; path: string }, env: Record<string, string>): DbContext {
    return {
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      worktreeId,
      worktreeName,
      worktreeBranch,
      worktreePath,
      dataDir: this.dataDir(worktreeId),
      logs: sinkFor(this.deps.logs, worktreeId, 'provision'),
      allocatePort: (name) => this.allocateDbPort(worktreeId, name, this.portKey({ branch: worktreeBranch, name: worktreeName }), project),
      env
    }
  }

  private dbContextFor(worktreeId: string): DbContext | null {
    const row = this.tryRow(worktreeId)
    if (!row) return null
    const project = this.deps.projects.get(row.project_id)
    return this.dbContext(worktreeId, row.name, row.branch, row.path, project, {})
  }

  private tryRow(worktreeId: string): WorktreeRow | undefined {
    try {
      return this.deps.worktrees.row(worktreeId)
    } catch {
      return undefined
    }
  }

  async resetDatabase(worktreeId: string, name: string, from?: DbSource): Promise<void> {
    const rt = this.runtime(worktreeId)
    await this.enqueue(rt, async () => {
      const row = this.deps.worktrees.row(worktreeId)
      const project = this.deps.projects.get(row.project_id)
      const loaded = loadCanopyConfig(row.path, project.path, this.home(project))
      const spec = loaded.config?.databases[name]
      if (!spec) throw notFound('database', name)
      const adapter = this.deps.databases.adapterFor(spec.adapter)
      const current = rt.env.databases.find((db) => db.name === name)
      const source: DbSource = from ?? 'template'
      const sourceCtx = typeof source === 'object' ? (this.dbContextFor(source.fromWorktree) ?? undefined) : undefined
      if (typeof source === 'object' && !sourceCtx) throw badRequest('unknown_worktree', 'the source worktree no longer exists')
      const ctx = this.dbContext(worktreeId, row.name, row.branch, row.path, project, Object.fromEntries(rt.env.env.map((v) => [v.key, v.value])))
      const forkedFrom = source === 'template' ? 'seed template' : source === 'empty' ? 'empty' : `worktree ${sourceCtx?.worktreeName ?? '?'}`
      const forkedFromBranch = sourceCtx?.worktreeBranch ?? null
      const envKey = dbEnvKey(name, spec)
      this.recordDatabase(worktreeId, { name, adapter: spec.adapter, status: 'forking', connectionUrl: current?.connectionUrl ?? null, envKey, forkedFrom, forkedFromDatabase: null, forkedFromBranch, sizeMb: null, seededAt: null, detail: current?.detail ?? {}, error: null })
      try {
        await adapter.destroy(name, spec, ctx)
        if (source === 'template') await adapter.ensureSource(name, spec, ctx, { refresh: false })
        const fork = await adapter.fork(name, spec, ctx, source, sourceCtx)
        this.recordDatabase(worktreeId, { name, adapter: spec.adapter, status: 'ready', connectionUrl: fork.url, envKey, forkedFrom, forkedFromDatabase: fork.sourceDatabase, forkedFromBranch, sizeMb: fork.sizeMb, seededAt: now(), detail: fork.detail, error: null })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.recordDatabase(worktreeId, { name, adapter: spec.adapter, status: 'error', connectionUrl: null, envKey, forkedFrom, forkedFromDatabase: null, forkedFromBranch, sizeMb: null, seededAt: null, detail: {}, error: message })
        throw error
      }
      await this.regenerateEnvFileNow(rt)
      if (LIVE_STATES.includes(rt.env.state)) ctx.logs.sys(`${name} re-forked — restart services that hold connections`)
    })
  }

  async refreshTemplate(project: Project, name: string): Promise<void> {
    const loaded = loadCanopyConfig(project.path, undefined, this.home(project))
    const spec = loaded.config?.databases[name]
    if (!spec) throw notFound('database', name)
    const adapter = this.deps.databases.adapterFor(spec.adapter)
    const ctx = this.dbContext(`template-${project.id}`, 'template', null, project.path, project, {})
    mkdirSync(ctx.dataDir, { recursive: true })
    await adapter.ensureSource(name, spec, ctx, { refresh: true })
  }

  private async regenerateEnvFileNow(rt: Runtime): Promise<void> {
    const resolved = this.ensureResolved(rt)
    await this.writeEnv(rt.id, resolved)
    const row = this.deps.worktrees.row(rt.id)
    this.update(rt, { env: resolved.env, envFile: resolved.envFile ? resolved.envFile.slice(row.path.length + 1) : null })
  }

  async regenerateEnvFile(worktreeId: string): Promise<void> {
    const rt = this.runtime(worktreeId)
    await this.enqueue(rt, () => this.regenerateEnvFileNow(rt))
  }

  // ---------- teardown & destroy ----------

  /** Everything but the checkout itself: services, containers, forks, ports, logs, data. */
  async teardown(worktreeId: string): Promise<void> {
    const rt = this.runtimes.get(worktreeId)
    if (!rt) {
      const row = this.tryRow(worktreeId)
      await this.releaseToolPorts(worktreeId, row, row ? this.deps.projects.get(row.project_id) : null)
      this.deps.ports.release(worktreeId)
      await this.deps.logs.remove(worktreeId).catch(() => undefined)
      return
    }
    rt.abort?.abort()
    await this.enqueue(rt, async () => {
      this.update(rt, { state: 'destroying', desired: 'stopped' })
      if (rt.supervisor) await rt.supervisor.dispose().catch(() => undefined)
      const records = this.db.prepare('SELECT * FROM service_state WHERE worktree_id = ?').all(worktreeId) as Array<{ name: string; runtime: 'host' | 'docker' | 'compose'; pid: number | null; pid_start: number | null; container_id: string | null; compose_project: string | null; restarts: number }>
      if (records.length > 0) {
        const supervisor = await this.supervisorFor(rt)
        await supervisor.reap(records.map((r) => ({ name: r.name, runtime: r.runtime, pid: r.pid, pidStart: r.pid_start, containerId: r.container_id, composeProject: r.compose_project, restarts: r.restarts })))
      }
      const row = this.tryRow(worktreeId)
      const project = row ? this.deps.projects.get(row.project_id) : null
      const loaded = row && project ? loadCanopyConfig(row.path, project.path, this.home(project)) : null
      for (const db of rt.env.databases) {
        const spec = loaded?.config?.databases[db.name]
        if (!spec || !row || !project) continue
        try {
          await this.deps.databases.adapterFor(spec.adapter).destroy(db.name, spec, this.dbContext(worktreeId, row.name, row.branch, row.path, project, {}))
        } catch (error) {
          sinkFor(this.deps.logs, worktreeId, 'provision').err(`drop ${db.name}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      this.db.prepare('DELETE FROM db_instances WHERE worktree_id = ?').run(worktreeId)
      this.db.prepare('DELETE FROM service_state WHERE worktree_id = ?').run(worktreeId)
      await this.releaseToolPorts(worktreeId, row, project)
      this.deps.ports.release(worktreeId)
      await this.deps.logs.remove(worktreeId).catch(() => undefined)
      rmSync(this.dataDir(worktreeId), { recursive: true, force: true })
    })
  }

  /** After a standalone teardown the checkout stays; the environment goes back to "not provisioned". */
  reset(worktreeId: string): void {
    const rt = this.runtimes.get(worktreeId)
    if (!rt) return
    const row = this.tryRow(worktreeId)
    const project = row ? this.deps.projects.get(row.project_id) : null
    const loaded = row && project ? loadCanopyConfig(row.path, project.path, this.home(project)) : null
    rt.supervisor = null
    rt.supervisorKind = null
    rt.resolved = null
    this.update(rt, { ...emptyEnvironment(loaded?.config !== null && loaded !== null, loaded?.report.errors ?? []), options: rt.env.options })
  }

  /** Forget a worktree after its row is gone. */
  forget(worktreeId: string): void {
    const rt = this.runtimes.get(worktreeId)
    if (rt?.persistTimer) clearTimeout(rt.persistTimer)
    if (rt?.emitTimer) clearTimeout(rt.emitTimer)
    this.runtimes.delete(worktreeId)
    this.deps.events.emit({ type: 'worktree-removed', worktreeId })
  }

  async stopAll(projectId: string): Promise<void> {
    const ids = (this.db.prepare('SELECT id FROM worktrees WHERE project_id = ?').all(projectId) as Array<{ id: string }>).map((r) => r.id)
    await Promise.all(ids.filter((id) => this.runtimes.has(id) && LIVE_STATES.includes(this.runtimes.get(id)!.env.state)).map((id) => this.stop(id)))
  }

  // ---------- open in editor / terminal ----------

  open(worktree: Worktree, input: OpenInput): { command: string } {
    const app = this.appSettings()
    const template = input.target === 'editor' ? app.editor.command : app.terminal.command
    if (!template.trim()) throw badRequest('no_launch_command', `no ${input.target} command configured in app preferences`)
    const file = input.file ? join(worktree.path, input.file) : worktree.path
    const command = template.replace(/\{path\}/g, quote(worktree.path)).replace(/\{file\}/g, quote(file)).replace(/\{line\}/g, String(input.line ?? 1))
    const child = spawn('/bin/sh', ['-c', command], { cwd: worktree.path, detached: true, stdio: 'ignore', env: process.env })
    child.on('error', () => undefined)
    child.unref()
    return { command }
  }

  // ---------- resources ----------

  resources(worktreeId: string): ResourceSample[] {
    return this.runtimes.get(worktreeId)?.history ?? []
  }

  private hostHistory: HostSample[] = []
  hostSamples(): HostSample[] {
    return this.hostHistory
  }

  private ensureTicker(): void {
    if (this.ticker) return
    this.ticker = setInterval(() => void this.tick().catch(() => undefined), TICK_MS)
  }

  private async tick(): Promise<void> {
    const live = [...this.runtimes.values()].filter((rt) => rt.supervisor && LIVE_STATES.includes(rt.env.state))
    const targets: Array<{ key: string; pid: number }> = []
    const containers: string[] = []
    for (const rt of live) {
      for (const [name, handle] of rt.supervisor!.handles()) {
        if (handle.pid) targets.push({ key: `${rt.id}/${name}`, pid: handle.pid })
        if (handle.containerId) containers.push(handle.containerId)
      }
    }
    const [processes, containerStats] = await Promise.all([this.deps.sampler.sampleProcesses(targets), this.deps.sampler.sampleContainers(containers)])
    const t = now()
    for (const rt of live) {
      const usage = new Map<string, { cpuPct: number; memMb: number }>()
      for (const [name, handle] of rt.supervisor!.handles()) {
        const fromProcess = handle.pid ? processes.get(`${rt.id}/${name}`) : undefined
        const fromContainer = handle.containerId ? containerStats.get(handle.containerId) : undefined
        const reading = fromProcess ?? fromContainer
        if (reading) usage.set(name, reading)
      }
      rt.supervisor!.setUsage(usage)
      const services = Object.fromEntries([...usage.entries()].map(([name, u]) => [name, { cpuPct: round(u.cpuPct), memMb: round(u.memMb) }]))
      const sample: ResourceSample = {
        t,
        services,
        totalCpuPct: round([...usage.values()].reduce((sum, u) => sum + u.cpuPct, 0)),
        totalMemMb: round([...usage.values()].reduce((sum, u) => sum + u.memMb, 0))
      }
      rt.history = rt.history.length >= HISTORY ? [...rt.history.slice(1), sample] : [...rt.history, sample]
      if (this.subscribers > 0) this.deps.events.emit({ type: 'resources', worktreeId: rt.id, sample })
    }
    const host = this.deps.sampler.sampleHost()
    this.hostHistory = this.hostHistory.length >= HISTORY ? [...this.hostHistory.slice(1), host] : [...this.hostHistory, host]
    if (this.subscribers > 0) this.deps.events.emit({ type: 'host', sample: host })
    if (live.length === 0 && this.subscribers === 0 && this.ticker) {
      clearInterval(this.ticker)
      this.ticker = null
    }
  }

  /** Called when an events client connects so host samples flow even with nothing running. */
  wake(): void {
    this.ensureTicker()
  }

  // ---------- boot & shutdown ----------

  /** Kill-and-respawn: reap what a previous daemon left, then restart worktrees desired running. */
  async reconcile(): Promise<void> {
    for (const rt of this.runtimes.values()) {
      const row = this.tryRow(rt.id)
      if (!row || row.missing || !existsSync(row.path)) continue
      const records = this.db.prepare('SELECT * FROM service_state WHERE worktree_id = ?').all(rt.id) as Array<{ name: string; runtime: 'host' | 'docker' | 'compose'; pid: number | null; pid_start: number | null; container_id: string | null; compose_project: string | null; restarts: number }>
      if (records.length > 0) {
        try {
          await (await this.supervisorFor(rt)).reap(records.map((r) => ({ name: r.name, runtime: r.runtime, pid: r.pid, pidStart: r.pid_start, containerId: r.container_id, composeProject: r.compose_project, restarts: r.restarts })))
        } catch {
          // best effort
        }
      }
    }
    for (const rt of this.runtimes.values()) {
      const row = this.tryRow(rt.id)
      if (!row || row.missing || !existsSync(row.path) || rt.env.desired !== 'running' || rt.env.state === 'error' || rt.env.state === 'none') continue
      try {
        await this.start(rt.id)
      } catch (error) {
        this.update(rt, { state: 'error', stateReason: `restart after daemon boot failed: ${error instanceof Error ? error.message : String(error)}` })
      }
    }
    this.ensureTicker()
  }

  private closing: Promise<void> | null = null

  /**
   * Stops every supervised service (graceful, then SIGKILL) within a bound, persists state and
   * closes the log store. Idempotent: the signal handler and Fastify's onClose both call it.
   */
  shutdown(): Promise<void> {
    if (this.closing) return this.closing
    this.closing = this.shutdownNow()
    return this.closing
  }

  private async shutdownNow(): Promise<void> {
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
    const runtimes = [...this.runtimes.values()]
    // Records first: if graceful stop overruns the bound, whatever is still alive gets reaped.
    const leftovers = runtimes.map((rt) => ({ rt, records: rt.supervisor?.records() ?? [] }))
    const graceful = Promise.all(
      runtimes.map(async (rt) => {
        rt.abort?.abort()
        if (rt.supervisor) await rt.supervisor.dispose().catch(() => undefined)
      })
    )
    const timedOut = await Promise.race([graceful.then(() => false), new Promise<boolean>((resolve) => setTimeout(() => resolve(true), SHUTDOWN_GRACE_MS).unref())])
    if (timedOut) {
      await Promise.all(leftovers.map(({ rt, records }) => (records.length > 0 && rt.supervisor ? rt.supervisor.reap(records).catch(() => undefined) : Promise.resolve())))
    }
    for (const rt of runtimes) {
      if (rt.persistTimer) clearTimeout(rt.persistTimer)
      if (rt.emitTimer) clearTimeout(rt.emitTimer)
      // Keep `desired` so reconcile() brings the worktree back; the snapshot says stopped for now.
      rt.env = { ...rt.env, services: rt.env.services.map((svc) => ({ ...svc, status: svc.excluded ? svc.status : 'stopped', pid: undefined, containerId: undefined })) }
      this.persist(rt)
    }
    await this.deps.logs.close()
  }
}

const round = (value: number): number => Math.round(value * 10) / 10

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
