/**
 * Service supervision through `canopyd run`.
 *
 * `WorktreeSupervisor` is a state machine, two clocks and three runners, all of it ours to keep
 * correct. This is the same contract with none of that: one `canopyd run --json --control` child
 * per worktree does the spawning, the health checks, the dependency waiting, the restart policy
 * and the crash-loop budget, and tells us what happened as one JSON event per line on stderr.
 * What is left here is translation — events into the `ServiceInfo` the Environment panel shows,
 * and the panel's start/stop/restart into lines on the child's stdin.
 *
 * Three things make that safe to lean on:
 *
 * - A requested stop *holds* a service, so `restart: always` cannot undo it. Calling `canopyd
 *   down` from here would look like a crash to the supervisor and be restarted a second later.
 * - End of input ends the run. If this daemon dies — cleanly or not — the kernel closes the pipe
 *   and canopyd stops every service itself, so there is nothing to reap on the next boot.
 * - The environment is handed over through the child's own environment (`--env KEY`), never as
 *   `KEY=VALUE` arguments: an argument list is readable by every user on the machine.
 *
 * Service output goes to canopyd's log file, not through us. One `canopyd logs -f --json` per
 * service tails it from the offset the log had before this start and appends to the daemon's log
 * store, so the logs route, its offsets and its SSE follow are untouched.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'

import type { ServiceInfo, ServiceStatus } from '@canopy/shared'

import type { LogSink, ResolvedService, RunContext, RunningHandle } from '../types'
import { resolveHealth, type ResolvedHealth } from './health'
import type { PreviousRecord, Supervisor } from './supervisor'

export interface CanopydSupervisorDeps {
  /** The `canopyd` binary; a test points this elsewhere. */
  bin?: string
  /** The worktree's branch. canopyd addresses a worktree by branch, so a detached one cannot use this. */
  branch: string
  /** Worktree-level context; `logs` is the worktree's own `supervisor` stream. */
  ctx: RunContext
  /** One sink per service (stream name = service name). */
  sinkFor: (service: string) => LogSink
  /** Debounced whenever any ServiceInfo field changes. */
  onChange: (services: ServiceInfo[]) => void
  /**
   * What this daemon knows and canopyd cannot resolve: database URLs from forks it made, project
   * and per-worktree settings. Read at spawn, so a regenerated environment takes effect on the
   * next start.
   */
  overrides: () => Record<string, string>
  now?: () => number
  /** Test seam. */
  spawn?: typeof nodeSpawn
}

/** One JSON line of `canopyd run --json` on stderr. See canopyd's docs/json-api.md. */
type RunEvent =
  | { event: 'started'; name: string; pid: number }
  | { event: 'healthy'; name: string }
  | { event: 'unhealthy'; name: string; detail: string }
  | { event: 'exited'; name: string; status: { exit: 'code'; code: number } | { exit: 'signal'; signal: number } | { exit: 'unknown' } }
  | { event: 'restarting'; name: string; attempt: number; delay_ms: number }
  | { event: 'gave_up'; name: string; restarts: number }
  | { event: 'stopped'; name: string }
  | { event: 'rejected'; request: string; detail: string }

interface Entry {
  service: ResolvedService
  health: ResolvedHealth
  info: ServiceInfo
  excluded: boolean
  /** Bumped on every `started`, so "it came back" is distinguishable from "it never left". */
  incarnation: number
  /** Where this service's canopyd log ended before the current run, i.e. where to tail from. */
  logOffset: number
  follower: ChildProcess | null
}

const CHANGE_DEBOUNCE_MS = 25
/** Slack on top of a service's own health budget before an operation stops waiting for it. */
const SETTLE_SLACK_MS = 5000
/** How long a follower gets to drain the last lines after its service is gone. */
const FOLLOWER_DRAIN_MS = 300
/** After asking the run to end, how long past the slowest `stop_timeout` before it is killed. */
const EXIT_SLACK_MS = 5000

const SETTLED: ReadonlySet<ServiceStatus> = new Set<ServiceStatus>(['healthy', 'unhealthy', 'failed', 'exited', 'stopped'])

/** Calls `onLine` for every complete line a stream delivers, however the chunks fall. */
function lines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  if (!stream) return
  let pending = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    pending += chunk
    let newline = pending.indexOf('\n')
    while (newline !== -1) {
      onLine(pending.slice(0, newline))
      pending = pending.slice(newline + 1)
      newline = pending.indexOf('\n')
    }
  })
  stream.on('end', () => {
    if (pending.length > 0) onLine(pending)
  })
}

export class CanopydSupervisor implements Supervisor {
  private entries = new Map<string, Entry>()
  private child: ChildProcess | null = null
  private exited: Promise<void> = Promise.resolve()
  private changeTimer: NodeJS.Timeout | null = null
  private readonly waiters = new Set<() => void>()
  private readonly rejections = new Map<string, string>()
  private disposed = false
  private readonly bin: string
  private readonly spawn: typeof nodeSpawn
  private readonly now: () => number

  constructor(private readonly deps: CanopydSupervisorDeps) {
    this.bin = deps.bin ?? 'canopyd'
    this.spawn = deps.spawn ?? nodeSpawn
    this.now = deps.now ?? Date.now
  }

  // ---------- public API ----------

  configure(services: ResolvedService[], excluded: Set<string>): void {
    const next = new Map<string, Entry>()
    for (const service of services) {
      const existing = this.entries.get(service.name)
      // Only the kind and the timing are used here; canopyd resolves and runs the check itself.
      const health = resolveHealth(service.spec.health, (text) => text)
      const info: ServiceInfo = {
        name: service.name,
        runtime: service.runtime,
        command: service.command,
        cwd: service.cwd,
        ports: service.ports,
        status: existing?.info.status ?? 'pending',
        restarts: existing?.info.restarts ?? 0,
        pid: existing?.info.pid,
        containerId: undefined,
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
      next.set(service.name, {
        service,
        health,
        info,
        excluded: excluded.has(service.name),
        incarnation: existing?.incarnation ?? 0,
        logOffset: existing?.logOffset ?? 0,
        follower: existing?.follower ?? null
      })
    }
    for (const [name, entry] of this.entries) if (!next.has(name)) this.endFollower(entry)
    this.entries = next
    this.changed()
  }

  async start(names?: string[]): Promise<void> {
    const targets = this.expand(names ?? [...this.entries.values()].filter((e) => !e.excluded && e.info.autostart).map((e) => e.info.name))
    if (targets.length === 0) return
    for (const name of targets) this.rejections.delete(name)

    if (!this.child) {
      await Promise.all(targets.map((name) => this.rememberLogEnd(name)))
      for (const name of targets) this.patch(name, { status: 'starting', lastError: null, exitCode: null })
      this.launch(targets)
    } else {
      for (const name of targets) {
        const entry = this.entries.get(name)
        if (!entry || entry.info.pid !== undefined) continue
        await this.rememberLogEnd(name)
        this.patch(name, { status: 'starting', lastError: null, exitCode: null })
        this.send(`start ${name}`)
      }
    }
    await this.until(() => targets.every((name) => this.settled(name) || this.rejections.has(name)), this.budget(targets))
  }

  async stop(names?: string[]): Promise<void> {
    if (!this.child) {
      for (const entry of this.entries.values()) this.patch(entry.info.name, { status: 'stopped', pid: undefined, startedAt: null })
      return
    }
    if (!names) {
      for (const entry of this.entries.values()) if (entry.info.pid !== undefined) this.patch(entry.info.name, { status: 'stopping' })
      await this.endRun()
      return
    }
    for (const name of names) {
      const entry = this.entries.get(name)
      if (!entry) continue
      this.rejections.delete(name)
      this.patch(name, { status: 'stopping' })
      this.send(`stop ${name}`)
    }
    const budget = Math.max(...names.map((name) => this.entries.get(name)?.service.stopTimeoutMs ?? 0)) + EXIT_SLACK_MS
    await this.until(() => names.every((name) => this.entries.get(name)?.info.status === 'stopped' || this.rejections.has(name)), budget)
  }

  async restart(name: string): Promise<void> {
    const entry = this.entries.get(name)
    if (!entry) return
    if (!this.child) return this.start([name])
    this.rejections.delete(name)
    const before = entry.incarnation
    await this.rememberLogEnd(name)
    this.patch(name, { status: 'stopping', restarts: 0 })
    this.send(`restart ${name}`)
    await this.until(() => (entry.incarnation > before && this.settled(name)) || this.rejections.has(name), entry.service.stopTimeoutMs + this.budget([name]))
  }

  snapshot(): ServiceInfo[] {
    return [...this.entries.values()].map((entry) => ({ ...entry.info }))
  }

  /** What the resource sampler needs: canopyd makes every service the leader of its own process group. */
  handles(): Map<string, RunningHandle> {
    const out = new Map<string, RunningHandle>()
    for (const entry of this.entries.values()) {
      if (entry.info.pid !== undefined) out.set(entry.info.name, { kind: 'host', pid: entry.info.pid, exited: new Promise(() => undefined) })
    }
    return out
  }

  records(): PreviousRecord[] {
    return [...this.entries.values()]
      .filter((entry) => entry.info.pid !== undefined)
      .map((entry) => ({ name: entry.info.name, runtime: 'host' as const, pid: entry.info.pid ?? null, pidStart: null, containerId: null, composeProject: null, restarts: entry.info.restarts }))
  }

  /**
   * Whatever a previous daemon left. Normally nothing: its `canopyd run` saw the pipe close and
   * stopped everything. `down` covers the case where that run was killed outright, and it is
   * canopyd that decides what is safe to signal — a recycled pid is refused, never killed.
   */
  async reap(_previous: PreviousRecord[]): Promise<void> {
    await this.exec(['down', this.deps.branch, '--json'])
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.changeTimer) clearTimeout(this.changeTimer)
    this.changeTimer = null
    await this.endRun()
    for (const entry of this.entries.values()) this.endFollower(entry, 0)
  }

  setUsage(usage: Map<string, { cpuPct: number; memMb: number }>): void {
    for (const entry of this.entries.values()) {
      const reading = usage.get(entry.info.name)
      entry.info.cpuPct = reading?.cpuPct
      entry.info.memMb = reading?.memMb
    }
    this.changed()
  }

  // ---------- the run ----------

  private launch(targets: string[]): void {
    const overrides = this.deps.overrides()
    const args = ['run', this.deps.branch, '--json', '--control']
    for (const name of targets) args.push('--only', name)
    // Names only. The values travel in the child's environment, where `ps` cannot show them.
    for (const key of Object.keys(overrides)) args.push('--env', key)

    const child = this.spawn(this.bin, args, {
      cwd: this.deps.ctx.worktreePath,
      // CANOPY_DAEMON=1 turns the `canopy` hook CLI into a no-op, as it does for `canopyd new`.
      env: { ...process.env, ...overrides, CANOPY_DAEMON: '1' },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child = child
    this.deps.ctx.logs.sys(`canopyd run ${targets.join(' ')}`)

    let envelope = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => (envelope += chunk))
    lines(child.stderr, (line) => this.onLine(line))
    // A write to a child that has already gone is reported through `exit`, not as a crash here.
    child.stdin?.on('error', () => undefined)

    this.exited = new Promise((resolve) => {
      const done = (failure: string | null): void => {
        if (this.child !== child) return
        this.child = null
        this.runEnded(failure ?? this.failureOf(envelope))
        resolve()
      }
      child.once('error', (error) => done(`could not run ${this.bin}: ${error.message}`))
      child.once('exit', () => done(null))
    })
  }

  /** The error canopyd reported for a run that never began, or null for one that ended normally. */
  private failureOf(envelope: string): string | null {
    try {
      const parsed = JSON.parse(envelope) as { ok?: boolean; error?: { message?: string } }
      return parsed.ok === false ? (parsed.error?.message ?? 'canopyd run failed') : null
    } catch {
      return envelope.trim().length === 0 ? null : envelope.trim()
    }
  }

  private runEnded(failure: string | null): void {
    if (failure) this.deps.ctx.logs.err(failure)
    for (const entry of this.entries.values()) {
      const live = entry.info.pid !== undefined || entry.info.status === 'starting' || entry.info.status === 'stopping' || entry.info.status === 'restarting'
      if (!live) continue
      // A run that refused to begin — a bad config, an unknown service — never started anything.
      this.patch(entry.info.name, failure ? { status: 'failed', lastError: failure, pid: undefined, startedAt: null } : { status: 'stopped', pid: undefined, startedAt: null })
      this.endFollower(entry)
    }
    this.wake()
  }

  private send(request: string): void {
    this.child?.stdin?.write(`${request}\n`)
  }

  /** Closes the control pipe, which is how a run is asked to end, and waits for it to. */
  private async endRun(): Promise<void> {
    const child = this.child
    if (!child) return
    child.stdin?.end()
    const slowest = Math.max(0, ...[...this.entries.values()].map((entry) => entry.service.stopTimeoutMs))
    const timer = setTimeout(() => child.kill('SIGKILL'), slowest * Math.max(1, this.entries.size) + EXIT_SLACK_MS)
    await this.exited
    clearTimeout(timer)
  }

  private onLine(line: string): void {
    let event: RunEvent
    try {
      event = JSON.parse(line) as RunEvent
    } catch {
      if (line.trim().length > 0) this.deps.ctx.logs.sys(line)
      return
    }
    this.onEvent(event)
    this.wake()
  }

  private onEvent(event: RunEvent): void {
    const sys = (text: string): void => this.deps.ctx.logs.sys(text)
    switch (event.event) {
      case 'started': {
        const entry = this.entries.get(event.name)
        if (!entry) return
        entry.incarnation += 1
        // With no health check, canopyd only reports `started` once the process has outlived
        // its start grace — which is exactly what `healthy` means for such a service here.
        this.patch(event.name, { status: entry.health.kind === 'none' ? 'healthy' : 'starting', pid: event.pid, startedAt: this.now(), exitCode: null, lastError: null })
        this.follow(entry)
        sys(`${event.name} started (pid ${event.pid})`)
        // The service's own log gets the lifecycle too, so reading it says when each run began
        // and how the last one ended without having to line it up against another stream.
        this.deps.sinkFor(event.name).sys(`started (pid ${event.pid})`)
        return
      }
      case 'healthy':
        this.patch(event.name, { status: 'healthy', lastError: null })
        return
      case 'unhealthy':
        this.patch(event.name, { status: 'unhealthy', lastError: event.detail })
        sys(`${event.name} is unhealthy: ${event.detail}`)
        return
      case 'exited': {
        const status = event.status
        const code = status.exit === 'code' ? status.code : null
        const why = status.exit === 'code' ? `exited with code ${status.code}` : status.exit === 'signal' ? `killed by signal ${status.signal}` : 'exited'
        this.patch(event.name, { status: 'exited', pid: undefined, exitCode: code, lastError: code === 0 ? null : why })
        sys(`${event.name} ${why}`)
        this.deps.sinkFor(event.name).sys(why)
        return
      }
      case 'restarting': {
        const entry = this.entries.get(event.name)
        this.patch(event.name, { status: 'restarting', restarts: (entry?.info.restarts ?? 0) + 1 })
        sys(`${event.name} restarting in ${event.delay_ms}ms (attempt ${event.attempt})`)
        return
      }
      case 'gave_up':
        this.patch(event.name, { status: 'failed', pid: undefined, lastError: `gave up after ${event.restarts} restarts` })
        sys(`${event.name} gave up after ${event.restarts} restarts`)
        return
      case 'stopped': {
        this.patch(event.name, { status: 'stopped', pid: undefined, startedAt: null })
        const entry = this.entries.get(event.name)
        if (entry) this.endFollower(entry)
        sys(`${event.name} stopped`)
        this.deps.sinkFor(event.name).sys('stopped')
        return
      }
      case 'rejected': {
        // `stop web` → `web`. The request is quoted back verbatim, so this is the service it named.
        const name = event.request.split(/\s+/)[1] ?? ''
        this.rejections.set(name, event.detail)
        if (this.entries.has(name)) this.patch(name, { lastError: event.detail })
        this.deps.ctx.logs.err(`${event.request}: ${event.detail}`)
        return
      }
    }
  }

  // ---------- logs ----------

  /** Where the service's canopyd log ends right now, so the next start is tailed from there. */
  private async rememberLogEnd(name: string): Promise<void> {
    const entry = this.entries.get(name)
    if (!entry) return
    const out = await this.exec(['logs', name, this.deps.branch, '--json', '--offsets', '-n', '0'])
    try {
      const parsed = JSON.parse(out) as { ok?: boolean; data?: { next_offset?: number } }
      entry.logOffset = parsed.ok ? (parsed.data?.next_offset ?? 0) : 0
    } catch {
      // No log yet, which is the normal case for a first start: everything in it will be new.
      entry.logOffset = 0
    }
  }

  private follow(entry: Entry): void {
    if (entry.follower || this.disposed) return
    const sink = this.deps.sinkFor(entry.info.name)
    const follower = this.spawn(this.bin, ['logs', entry.info.name, this.deps.branch, '-f', '--json', '--since', String(entry.logOffset)], {
      cwd: this.deps.ctx.worktreePath,
      env: { ...process.env, CANOPY_DAEMON: '1' },
      stdio: ['ignore', 'pipe', 'ignore']
    })
    entry.follower = follower
    lines(follower.stdout, (line) => {
      try {
        const event = JSON.parse(line) as { event: 'line'; offset: number; text: string } | { event: 'reset'; next_offset: number }
        if (event.event !== 'line') return
        sink.out(event.text)
        // Kept current so a follower that is replaced picks up exactly where this one stopped.
        entry.logOffset = event.offset + Buffer.byteLength(event.text) + 1
      } catch {
        // Not an event; canopyd only prints events here.
      }
    })
    follower.once('error', () => undefined)
    follower.once('exit', () => {
      if (entry.follower === follower) entry.follower = null
    })
  }

  /** Lets the follower read the service's last words, then ends it. */
  private endFollower(entry: Entry, drainMs = FOLLOWER_DRAIN_MS): void {
    const follower = entry.follower
    if (!follower) return
    entry.follower = null
    if (drainMs === 0) follower.kill('SIGINT')
    else setTimeout(() => follower.kill('SIGINT'), drainMs).unref()
  }

  // ---------- plumbing ----------

  /** A one-shot canopyd command's stdout. Failures are the caller's to interpret: the envelope says. */
  private exec(args: string[]): Promise<string> {
    return new Promise((resolve) => {
      let out = ''
      const child = this.spawn(this.bin, args, { cwd: this.deps.ctx.worktreePath, env: { ...process.env, CANOPY_DAEMON: '1' }, stdio: ['ignore', 'pipe', 'ignore'] })
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => (out += chunk))
      child.once('error', () => resolve(''))
      child.once('close', () => resolve(out))
    })
  }

  /** `names` plus everything they depend on, dependencies first, minus what is excluded. */
  private expand(names: string[]): string[] {
    const out: string[] = []
    const visit = (name: string): void => {
      const entry = this.entries.get(name)
      if (!entry || entry.excluded || out.includes(name)) return
      for (const dep of entry.service.spec.depends_on) visit(dep)
      if (!out.includes(name)) out.push(name)
    }
    for (const name of names) visit(name)
    return out
  }

  private settled(name: string): boolean {
    const entry = this.entries.get(name)
    return !entry || SETTLED.has(entry.info.status)
  }

  /** How long a start of `names` may take: each one's own health budget, end to end, since dependencies wait. */
  private budget(names: string[]): number {
    return names.reduce((total, name) => {
      const health = this.entries.get(name)?.health
      return total + (health ? health.startPeriodMs + health.retries * health.intervalMs : 0) + SETTLE_SLACK_MS
    }, SETTLE_SLACK_MS)
  }

  /** Resolves when `done()` holds, the run ends, or `timeoutMs` passes — whichever is first. */
  private until(done: () => boolean, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const check = (): void => {
        if (!done() && this.child) return
        clearTimeout(timer)
        this.waiters.delete(check)
        resolve()
      }
      const timer = setTimeout(() => {
        this.waiters.delete(check)
        resolve()
      }, timeoutMs)
      this.waiters.add(check)
      check()
    })
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter()
  }

  private patch(name: string, fields: Partial<ServiceInfo>): void {
    const entry = this.entries.get(name)
    if (!entry) return
    Object.assign(entry.info, fields)
    this.changed()
  }

  private changed(): void {
    if (this.disposed || this.changeTimer) return
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null
      if (!this.disposed) this.deps.onChange(this.snapshot())
    }, CHANGE_DEBOUNCE_MS)
  }
}
