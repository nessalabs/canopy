/**
 * Per-worktree service supervision: everything that is the same whether a service is a host
 * process, a container or a compose stack lives here, and everything that differs lives behind
 * `ServiceRunner`.
 *
 * The design is a small state machine per service plus two clocks (a health poll and a restart
 * backoff), because that is what makes the Environment panel honest: a service is `starting` until
 * its own health check says otherwise, `unhealthy` is a distinct state from `exited`, and a crash
 * loop ends in `failed` instead of hammering the machine forever. Every asynchronous callback is
 * tagged with the entry's `generation`, which is bumped on stop/restart/reconfigure — that is how
 * a health tick or an exit handler from a previous incarnation is recognised and dropped instead
 * of corrupting the state of the process that replaced it.
 */
import { startOrder, type ServiceInfo, type ServiceSpec, type ServiceStatus } from '@canopy/shared'

import type { LogSink, LogStore, ResolvedService, RunContext, RunningHandle, ServiceRunner } from '../types'
import { probe, resolveHealth, type ResolvedHealth } from './health'

export interface SupervisorDeps {
  runners: Record<'host' | 'docker' | 'compose', ServiceRunner>
  /** Worktree-level context; `logs` is the worktree's own `supervisor` stream. */
  ctx: RunContext
  logs: LogStore
  /** One sink per service (stream name = service name); the runners write stdout/stderr into it. */
  sinkFor: (service: string) => LogSink
  /** Debounced (≤ 50ms) whenever any ServiceInfo field changes. */
  onChange: (services: ServiceInfo[]) => void
  /** Renders `${ports.x}` etc. in health targets. */
  interpolate: (text: string) => string
  now?: () => number
  /** Test seam: the restart backoff. Defaults to 1s doubling to 30s. */
  backoff?: { baseMs: number; maxMs: number }
}

/** What the daemon persists so the next boot can kill whatever this one left running. */
export interface PreviousRecord {
  name: string
  runtime: 'host' | 'docker' | 'compose'
  pid: number | null
  pidStart: number | null
  containerId: string | null
  composeProject: string | null
  restarts: number
}

const CHANGE_DEBOUNCE_MS = 25
/** How long a service with no health check must stay up before it counts as healthy. */
const ALIVE_GRACE_MS = 750
const RESTART_WINDOW_MS = 60_000
const MAX_RESTARTS = 5
const DEFAULT_BACKOFF = { baseMs: 1000, maxMs: 30_000 }
/** Slack added to a service's own health budget before `start()` stops waiting for it. */
const SETTLE_SLACK_MS = 5000

/** Statuses that mean "this service is not going to change on its own any more". */
const SETTLED: ReadonlySet<ServiceStatus> = new Set<ServiceStatus>(['healthy', 'unhealthy', 'failed', 'exited', 'stopped'])

interface Entry {
  service: ResolvedService
  health: ResolvedHealth
  info: ServiceInfo
  sink: LogSink
  handle: RunningHandle | null
  desired: 'running' | 'stopped'
  excluded: boolean
  /** Incremented on every start/stop; async callbacks from older incarnations are ignored. */
  generation: number
  failures: number
  backoffMs: number
  /** Timestamps of recent restarts, for the crash-loop budget. */
  restartAt: number[]
  healthTimer: NodeJS.Timeout | null
  restartTimer: NodeJS.Timeout | null
  lock: Promise<void>
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** A stand-in spec for reaping a service the current config no longer contains. */
function syntheticService(name: string, runtime: 'host' | 'docker' | 'compose', cwd: string): ResolvedService {
  const spec: ServiceSpec = { run: '', env: {}, depends_on: [], restart: 'never', autostart: false, stop_signal: 'SIGTERM', stop_timeout: '10s' }
  return { name, spec, runtime, command: '', cwd, env: {}, ports: [], stopSignal: 'SIGTERM', stopTimeoutMs: 10_000 }
}

export class WorktreeSupervisor {
  private entries = new Map<string, Entry>()
  private readonly timers = new Set<NodeJS.Timeout>()
  private readonly waiters = new Set<(giveUp: boolean) => void>()
  private changeTimer: NodeJS.Timeout | null = null
  private disposed = false
  private readonly backoff: { baseMs: number; maxMs: number }

  constructor(private readonly deps: SupervisorDeps) {
    this.backoff = deps.backoff ?? DEFAULT_BACKOFF
  }

  // ---------- public API ----------

  /** Replaces the service set (after (re)provision). Excluded services appear with `excluded` and never start. */
  configure(services: ResolvedService[], excluded: Set<string>): void {
    const next = new Map<string, Entry>()
    for (const service of services) {
      const existing = this.entries.get(service.name)
      const health = resolveHealth(service.spec.health, this.deps.interpolate)
      const info: ServiceInfo = {
        name: service.name,
        runtime: service.runtime,
        command: service.command,
        cwd: service.cwd,
        ports: service.ports,
        status: existing?.info.status ?? 'pending',
        restarts: existing?.info.restarts ?? 0,
        pid: existing?.info.pid,
        containerId: existing?.info.containerId,
        cpuPct: existing?.info.cpuPct,
        memMb: existing?.info.memMb,
        excluded: excluded.has(service.name),
        autostart: service.spec.autostart,
        health: health.kind,
        dependsOn: service.spec.depends_on,
        startedAt: existing?.info.startedAt ?? null,
        exitCode: existing?.info.exitCode ?? null,
        lastError: existing?.info.lastError ?? null
      }
      if (existing) {
        existing.service = service
        existing.health = health
        existing.excluded = info.excluded
        existing.info = info
        next.set(service.name, existing)
      } else {
        next.set(service.name, {
          service,
          health,
          info,
          sink: this.deps.sinkFor(service.name),
          handle: null,
          desired: 'stopped',
          excluded: info.excluded,
          generation: 0,
          failures: 0,
          backoffMs: this.backoff.baseMs,
          restartAt: [],
          healthTimer: null,
          restartTimer: null,
          lock: Promise.resolve()
        })
      }
    }
    for (const [name, entry] of this.entries) {
      if (!next.has(name) && entry.handle) this.deps.ctx.logs.sys(`service ${name} left the config while running — stop it before reconfiguring`)
    }
    this.entries = next
    this.scheduleChange()
  }

  /**
   * Starts services honouring `depends_on`: a service waits until each dependency is healthy (a
   * dependency with no health check becomes healthy shortly after it starts). Dependencies of the
   * requested services are started too. Resolves once every requested service settled — bounded by
   * its own `start_period + retries × interval`, so a service that never comes up cannot hang a
   * provision run.
   */
  async start(names?: string[]): Promise<void> {
    const requested = this.expand(names ?? this.autostartNames())
    for (const name of requested) {
      const entry = this.entries.get(name)
      if (!entry) continue
      entry.desired = 'running'
      // Mark synchronously so a dependent that checks "is my dep settled?" cannot see the stale
      // `stopped` of a service that is about to start one tick later.
      if (!entry.handle && entry.info.status !== 'starting') this.patch(entry, { status: 'starting', lastError: null })
    }
    await Promise.all(
      requested.map(async (name) => {
        await this.startOne(name)
        const entry = this.entries.get(name)
        if (!entry || entry.excluded) return
        await this.waitUntil(() => SETTLED.has(entry.info.status), this.settleBound(entry))
      })
    )
  }

  /** Stops in reverse dependency order (dependents first) and resolves when everything is stopped. */
  async stop(names?: string[]): Promise<void> {
    const targets = this.ordered(names ?? [...this.entries.keys()]).reverse()
    for (const name of targets) await this.stopOne(name)
  }

  async restart(name: string): Promise<void> {
    const entry = this.entries.get(name)
    if (!entry || entry.excluded) return
    await this.stop([name])
    // A deliberate restart forgives the crash-loop budget and the accumulated backoff.
    entry.restartAt = []
    entry.backoffMs = this.backoff.baseMs
    this.patch(entry, { restarts: entry.info.restarts + 1 })
    await this.start([name])
  }

  snapshot(): ServiceInfo[] {
    return [...this.entries.values()].map((entry) => entry.info)
  }

  /** Live handles for the resource sampler: pid (host) / containerId (docker) per service. */
  handles(): Map<string, RunningHandle> {
    const live = new Map<string, RunningHandle>()
    for (const [name, entry] of this.entries) if (entry.handle) live.set(name, entry.handle)
    return live
  }

  records(): PreviousRecord[] {
    const records: PreviousRecord[] = []
    for (const entry of this.entries.values()) {
      if (!entry.handle) continue
      records.push({
        name: entry.info.name,
        runtime: entry.service.runtime,
        pid: entry.handle.pid ?? null,
        pidStart: entry.handle.pidStart ?? null,
        containerId: entry.handle.containerId ?? null,
        composeProject: entry.handle.composeProject ?? null,
        restarts: entry.info.restarts
      })
    }
    return records
  }

  /** Kill-and-respawn support: kills whatever a previous daemon left for these records. Never throws. */
  async reap(previous: PreviousRecord[]): Promise<void> {
    for (const record of previous) {
      try {
        const runner = this.deps.runners[record.runtime]
        if (!runner) continue
        const entry = this.entries.get(record.name)
        const service = entry?.service ?? syntheticService(record.name, record.runtime, this.deps.ctx.worktreePath)
        const ctx = entry ? this.ctxFor(entry) : this.deps.ctx
        await runner.reap(ctx, service, {
          pid: record.pid ?? undefined,
          pidStart: record.pidStart ?? undefined,
          containerId: record.containerId ?? undefined,
          composeProject: record.composeProject ?? undefined
        })
        if (entry) {
          entry.handle = null
          this.patch(entry, { restarts: record.restarts, pid: undefined, containerId: undefined })
        }
      } catch {
        // Boot reconcile must survive anything a previous daemon left behind.
      }
    }
  }

  /** Stops everything and cancels every timer; after this the supervisor holds no handles. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.stop()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    if (this.changeTimer) clearTimeout(this.changeTimer)
    this.changeTimer = null
    for (const waiter of [...this.waiters]) waiter(true)
    this.waiters.clear()
  }

  /** Applies one sampler tick; services with no sample lose their numbers rather than freezing them. */
  setUsage(usage: Map<string, { cpuPct: number; memMb: number }>): void {
    for (const entry of this.entries.values()) {
      const sample = usage.get(entry.info.name)
      if (sample) this.patch(entry, { cpuPct: sample.cpuPct, memMb: sample.memMb })
      else if (entry.info.cpuPct !== undefined || entry.info.memMb !== undefined) this.patch(entry, { cpuPct: undefined, memMb: undefined })
    }
  }

  // ---------- lifecycle ----------

  private async startOne(name: string): Promise<void> {
    const entry = this.entries.get(name)
    if (!entry || entry.excluded) return
    await this.awaitDependencies(entry)
    await this.withLock(entry, async () => {
      if (entry.desired !== 'running' || this.disposed) return
      await this.launch(entry)
    })
  }

  private async awaitDependencies(entry: Entry): Promise<void> {
    for (const name of entry.service.spec.depends_on) {
      const dep = this.entries.get(name)
      if (!dep || dep.excluded) continue
      await this.waitUntil(() => dep.info.status === 'healthy' || SETTLED.has(dep.info.status), this.settleBound(dep))
      if (dep.info.status !== 'healthy') entry.sink.sys(`dependency ${name} is ${dep.info.status} — starting anyway`)
    }
  }

  /** Runs under the entry's lock. */
  private async launch(entry: Entry): Promise<void> {
    const runner = this.runnerFor(entry)
    if (entry.handle && (await runner.alive(entry.handle))) return

    const generation = ++entry.generation
    entry.failures = 0
    this.clearEntryTimers(entry)
    this.patch(entry, { status: 'starting', exitCode: null, lastError: null, startedAt: this.now(), pid: undefined, containerId: undefined })

    let handle: RunningHandle
    try {
      handle = await runner.start(this.ctxFor(entry), entry.service)
    } catch (error) {
      const text = message(error)
      entry.sink.sys(`start failed: ${text}`)
      this.patch(entry, { status: 'failed', lastError: text })
      return
    }
    if (generation !== entry.generation || this.disposed) {
      // A stop landed while the runner was starting: undo it rather than leak the process.
      await runner.stop(handle, entry.service, this.ctxFor(entry)).catch(() => {})
      return
    }

    entry.handle = handle
    this.patch(entry, { pid: handle.pid, containerId: handle.containerId })
    void handle.exited.then(
      (result) => this.onExit(entry, generation, result),
      () => this.onExit(entry, generation, { code: null, signal: null })
    )
    this.beginHealth(entry, generation)
  }

  private async stopOne(name: string): Promise<void> {
    const entry = this.entries.get(name)
    if (!entry || entry.excluded) return
    entry.desired = 'stopped'
    await this.withLock(entry, async () => {
      // Bumping the generation retires the health loop, the exit handler and any pending restart.
      entry.generation += 1
      this.clearEntryTimers(entry)
      const handle = entry.handle
      entry.handle = null
      if (!handle) {
        if (entry.info.status !== 'pending') this.patch(entry, { status: 'stopped', pid: undefined, containerId: undefined })
        return
      }
      this.patch(entry, { status: 'stopping' })
      entry.sink.sys('stopping')
      try {
        await this.runnerFor(entry).stop(handle, entry.service, this.ctxFor(entry))
      } catch (error) {
        entry.sink.sys(`stop failed: ${message(error)}`)
      }
      entry.sink.sys('stopped')
      this.patch(entry, { status: 'stopped', pid: undefined, containerId: undefined, startedAt: null })
    })
  }

  private onExit(entry: Entry, generation: number, result: { code: number | null; signal: string | null }): void {
    if (generation !== entry.generation) return
    entry.handle = null
    this.clearEntryTimers(entry)
    if (entry.desired === 'stopped' || this.disposed) {
      this.patch(entry, { status: 'stopped', exitCode: result.code, pid: undefined, containerId: undefined, startedAt: null })
      return
    }

    const how = result.signal ? `signal ${result.signal}` : `code ${result.code ?? '?'}`
    entry.sink.sys(`exited (${how})`)
    this.patch(entry, { status: 'exited', exitCode: result.code, pid: undefined, containerId: undefined, startedAt: null })

    const policy = entry.service.spec.restart
    if (policy === 'never' || (policy === 'on-failure' && result.code === 0)) return

    const at = this.now()
    entry.restartAt = entry.restartAt.filter((time) => at - time < RESTART_WINDOW_MS)
    if (entry.restartAt.length >= MAX_RESTARTS) {
      const text = `gave up after ${MAX_RESTARTS} restarts in ${Math.round(RESTART_WINDOW_MS / 1000)}s`
      entry.sink.sys(text)
      this.patch(entry, { status: 'failed', lastError: text })
      return
    }
    entry.restartAt.push(at)
    const delay = entry.backoffMs
    entry.backoffMs = Math.min(entry.backoffMs * 2, this.backoff.maxMs)
    entry.sink.sys(`restarting (${how}) in ${delay}ms`)
    this.patch(entry, { status: 'restarting', restarts: entry.info.restarts + 1 })
    entry.restartTimer = this.later(() => {
      entry.restartTimer = null
      void this.withLock(entry, async () => {
        if (entry.desired !== 'running' || this.disposed) return
        await this.launch(entry)
      })
    }, delay)
  }

  // ---------- health ----------

  private beginHealth(entry: Entry, generation: number): void {
    if (entry.health.kind === 'none') {
      // Nothing to probe: staying up for a moment is the only evidence of health there is.
      entry.healthTimer = this.later(() => {
        entry.healthTimer = null
        if (generation !== entry.generation || entry.info.status !== 'starting') return
        this.markHealthy(entry)
      }, ALIVE_GRACE_MS)
      return
    }

    const tick = async (): Promise<void> => {
      entry.healthTimer = null
      if (generation !== entry.generation || this.disposed) return
      const result = await probe(entry.health, { cwd: entry.service.cwd, env: entry.service.env })
      if (generation !== entry.generation || this.disposed) return
      if (result.ok) {
        entry.failures = 0
        if (entry.info.status === 'starting' || entry.info.status === 'unhealthy') this.markHealthy(entry)
      } else {
        entry.failures += 1
        if (entry.failures >= entry.health.retries && (entry.info.status === 'starting' || entry.info.status === 'healthy')) {
          entry.sink.sys(`unhealthy: ${result.detail ?? 'check failed'}`)
          this.patch(entry, { status: 'unhealthy', lastError: result.detail ?? null })
        }
      }
      // Chained timeouts, never setInterval: a slow probe must not let ticks pile up on each other.
      if (generation === entry.generation && !this.disposed) entry.healthTimer = this.later(() => void tick(), entry.health.intervalMs)
    }
    // The grace period is honoured by delaying the *first* probe, so early failures never count.
    entry.healthTimer = this.later(() => void tick(), entry.health.startPeriodMs)
  }

  private markHealthy(entry: Entry): void {
    entry.backoffMs = this.backoff.baseMs
    entry.sink.sys('healthy')
    this.patch(entry, { status: 'healthy', lastError: null })
  }

  /** Upper bound on how long a service may legitimately stay `starting`. */
  private settleBound(entry: Entry): number {
    if (entry.health.kind === 'none') return ALIVE_GRACE_MS + SETTLE_SLACK_MS
    return entry.health.startPeriodMs + entry.health.retries * entry.health.intervalMs + SETTLE_SLACK_MS
  }

  // ---------- plumbing ----------

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private runnerFor(entry: Entry): ServiceRunner {
    return this.deps.runners[entry.service.runtime]
  }

  private ctxFor(entry: Entry): RunContext {
    return { ...this.deps.ctx, logs: entry.sink }
  }

  private autostartNames(): string[] {
    return [...this.entries.values()].filter((entry) => entry.info.autostart && !entry.excluded).map((entry) => entry.info.name)
  }

  /** The requested services plus their (transitive) dependencies, in dependency order. */
  private expand(names: string[]): string[] {
    const wanted = new Set<string>()
    const visit = (name: string): void => {
      const entry = this.entries.get(name)
      if (!entry || entry.excluded || wanted.has(name)) return
      wanted.add(name)
      for (const dep of entry.service.spec.depends_on) visit(dep)
    }
    for (const name of names) visit(name)
    return this.ordered([...wanted])
  }

  private ordered(names: string[]): string[] {
    const specs: Record<string, ServiceSpec> = {}
    for (const [name, entry] of this.entries) specs[name] = entry.service.spec
    try {
      return startOrder(specs, new Set(names))
    } catch {
      // A cycle is a config error caught by the linter; fall back to the configured order.
      return names.filter((name) => this.entries.has(name))
    }
  }

  /** Serialises start/stop/restart per service so two callers cannot interleave. */
  private async withLock<T>(entry: Entry, action: () => Promise<T>): Promise<T> {
    const previous = entry.lock
    let release = (): void => {}
    entry.lock = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await action()
    } finally {
      release()
    }
  }

  private later(action: () => void, ms: number): NodeJS.Timeout {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      action()
    }, Math.max(0, ms))
    this.timers.add(timer)
    return timer
  }

  private cancel(timer: NodeJS.Timeout | null): void {
    if (!timer) return
    clearTimeout(timer)
    this.timers.delete(timer)
  }

  private clearEntryTimers(entry: Entry): void {
    this.cancel(entry.healthTimer)
    this.cancel(entry.restartTimer)
    entry.healthTimer = null
    entry.restartTimer = null
  }

  /** Replaces `info` (never mutates it) so consumers can compare by reference. */
  private patch(entry: Entry, changes: Partial<ServiceInfo>): void {
    const current = entry.info as unknown as Record<string, unknown>
    let changed = false
    for (const [key, value] of Object.entries(changes)) if (current[key] !== value) changed = true
    if (!changed) return
    entry.info = { ...entry.info, ...changes }
    this.scheduleChange()
    this.notify()
  }

  private scheduleChange(): void {
    if (this.disposed || this.changeTimer) return
    this.changeTimer = this.later(() => {
      this.changeTimer = null
      this.deps.onChange(this.snapshot())
    }, CHANGE_DEBOUNCE_MS)
  }

  private notify(): void {
    for (const waiter of [...this.waiters]) waiter(false)
  }

  /** Resolves true when `test` holds, false on timeout or dispose. */
  private waitUntil(test: () => boolean, timeoutMs: number): Promise<boolean> {
    if (test()) return Promise.resolve(true)
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = null
      const settle = (ok: boolean): void => {
        this.waiters.delete(listener)
        this.cancel(timer)
        resolve(ok)
      }
      const listener = (giveUp: boolean): void => {
        if (giveUp) settle(false)
        else if (test()) settle(true)
      }
      this.waiters.add(listener)
      timer = this.later(() => settle(false), timeoutMs)
    })
  }
}
