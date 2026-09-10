import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { HealthCheck, LogLine, ServiceInfo, ServiceSpec } from '@canopy/shared'

import { createHostRunner, pidAlive } from '../../src/env/services/runners/host'
import { WorktreeSupervisor, type PreviousRecord, type SupervisorDeps } from '../../src/env/services/supervisor'
import type { LogSink, LogStore, ResolvedService, RunningHandle, ServiceRunner } from '../../src/env/types'

// ---------- fakes ----------

interface MemoryLogs {
  store: LogStore
  sinkFor: (service: string) => LogSink
  /** Every line in arrival order, so a test can assert the ordering across services. */
  lines: Array<{ service: string; stream: string; text: string }>
  textsFor(service: string): string[]
  indexOf(service: string, match: RegExp): number
}

function memoryLogs(): MemoryLogs {
  const lines: MemoryLogs['lines'] = []
  const store: LogStore = {
    append(_worktreeId, stream, line) {
      lines.push({ service: stream, stream: line.stream, text: line.text })
      return { offset: lines.length - 1, ts: line.ts ?? Date.now(), stream: line.stream, text: line.text } satisfies LogLine
    },
    async read() {
      return { lines: [], nextOffset: lines.length, truncated: false }
    },
    subscribe: () => () => {},
    async clear() {},
    async remove() {},
    async close() {}
  }
  return {
    store,
    sinkFor: (service) => ({
      out: (text) => void store.append('wt', service, { stream: 'out', text }),
      err: (text) => void store.append('wt', service, { stream: 'err', text }),
      sys: (text) => void store.append('wt', service, { stream: 'sys', text })
    }),
    lines,
    textsFor: (service) => lines.filter((line) => line.service === service).map((line) => line.text),
    indexOf: (service, match) => lines.findIndex((line) => line.service === service && match.test(line.text))
  }
}

/** A runner that records calls without touching docker; the host runner is the real one. */
function stubRunner(kind: 'docker' | 'compose'): ServiceRunner & { calls: string[] } {
  const calls: string[] = []
  return {
    kind,
    calls,
    async start(_ctx, service): Promise<RunningHandle> {
      calls.push(`start:${service.name}`)
      return { kind, containerId: `fake-${service.name}`, exited: new Promise(() => {}) }
    },
    async stop(_handle, service) {
      calls.push(`stop:${service.name}`)
    },
    async alive() {
      return true
    },
    async reap(_ctx, service) {
      calls.push(`reap:${service.name}`)
    }
  }
}

const spec = (partial: Partial<ServiceSpec> = {}): ServiceSpec => ({
  run: 'true',
  env: {},
  depends_on: [],
  restart: 'never',
  autostart: true,
  stop_signal: 'SIGTERM',
  stop_timeout: '10s',
  ...partial
})

const health = (partial: Partial<HealthCheck>): HealthCheck => ({ interval: '100ms', timeout: '500ms', retries: 5, start_period: '0s', ...partial }) as HealthCheck

function service(name: string, command: string, overrides: Partial<ResolvedService> = {}, specOverrides: Partial<ServiceSpec> = {}): ResolvedService {
  return {
    name,
    spec: spec({ run: command, ...specOverrides }),
    runtime: 'host',
    command,
    cwd: process.cwd(),
    env: {},
    ports: [],
    stopSignal: 'SIGTERM',
    stopTimeoutMs: 2000,
    ...overrides
  }
}

const freePort = (): Promise<number> =>
  new Promise((done) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => done(port))
    })
  })

const waitFor = async (test: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (test()) return
    await new Promise((done) => setTimeout(done, 20))
  }
  throw new Error('timed out waiting for condition')
}

// ---------- suite ----------

describe('WorktreeSupervisor', () => {
  let logs: MemoryLogs
  let changes: ServiceInfo[][]
  let dataDir: string
  let supervisor: WorktreeSupervisor

  const build = (extra: Partial<SupervisorDeps> = {}): WorktreeSupervisor =>
    new WorktreeSupervisor({
      runners: { host: createHostRunner(), docker: stubRunner('docker'), compose: stubRunner('compose') },
      ctx: { worktreeId: 'wt-abcdef12', worktreePath: process.cwd(), projectName: 'canopy', dataDir, logs: logs.sinkFor('supervisor') },
      logs: logs.store,
      sinkFor: logs.sinkFor,
      onChange: (services) => changes.push(services),
      interpolate: (text) => text,
      backoff: { baseMs: 10, maxMs: 20 },
      ...extra
    })

  beforeEach(() => {
    logs = memoryLogs()
    changes = []
    dataDir = mkdtempSync(join(tmpdir(), 'canopy-sup-'))
    supervisor = build()
  })

  afterEach(async () => {
    await supervisor.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  })

  const statusOf = (name: string): string => supervisor.snapshot().find((info) => info.name === name)?.status ?? 'missing'

  it('starts dependencies first and only when they are healthy', async () => {
    const port = await freePort()
    const api = service('api', `node -e "setTimeout(() => require('http').createServer((q, s) => s.end('ok')).listen(${port}, '127.0.0.1'), 300)"`, {}, {
      health: health({ http: `http://127.0.0.1:${port}/` })
    })
    const web = service('web', 'sleep 5', {}, { depends_on: ['api'] })
    supervisor.configure([web, api], new Set())

    await supervisor.start()

    expect(statusOf('api')).toBe('healthy')
    expect(statusOf('web')).toBe('healthy')
    const apiHealthy = logs.indexOf('api', /^healthy$/)
    const webStarted = logs.indexOf('web', /^started pid/)
    expect(apiHealthy).toBeGreaterThan(-1)
    expect(webStarted).toBeGreaterThan(apiHealthy)
  })

  it('marks a service with no health check healthy once it stays up', async () => {
    supervisor.configure([service('idle', 'sleep 5')], new Set())
    await supervisor.start()
    expect(statusOf('idle')).toBe('healthy')
    expect(logs.textsFor('idle')).toContain('healthy')
  })

  it('turns unhealthy when the probe keeps failing, and reports the detail', async () => {
    const port = await freePort()
    const dead = service('dead', 'sleep 10', {}, { health: health({ tcp: String(port), retries: 2 }) })
    supervisor.configure([dead], new Set())

    await supervisor.start()

    expect(statusOf('dead')).toBe('unhealthy')
    expect(supervisor.snapshot()[0]?.lastError).toBeTruthy()
  })

  it('restarts on failure with a growing backoff and gives up after the limit', async () => {
    supervisor.configure([service('crash', 'exit 1', {}, { restart: 'on-failure' })], new Set())

    await supervisor.start()
    await waitFor(() => statusOf('crash') === 'failed')

    const info = supervisor.snapshot()[0]
    expect(info?.restarts).toBe(5)
    expect(info?.exitCode).toBe(1)
    expect(info?.lastError).toMatch(/gave up after 5 restarts/)
    expect(logs.textsFor('crash').filter((text) => text.startsWith('restarting (code 1)'))).toHaveLength(5)
    expect(logs.textsFor('crash')).toContain('exited (code 1)')
  })

  it('does not restart when the policy is never, or when on-failure sees a clean exit', async () => {
    supervisor.configure([service('once', 'exit 0', {}, { restart: 'on-failure' }), service('done', 'exit 2', {}, { restart: 'never' })], new Set())

    await supervisor.start()
    await waitFor(() => statusOf('once') === 'exited' && statusOf('done') === 'exited')
    await new Promise((done) => setTimeout(done, 100))

    expect(supervisor.snapshot().map((info) => info.restarts)).toEqual([0, 0])
    expect(supervisor.snapshot().find((info) => info.name === 'done')?.exitCode).toBe(2)
  })

  it('stops in reverse dependency order', async () => {
    const a = service('a', 'sleep 5')
    const b = service('b', 'sleep 5', {}, { depends_on: ['a'] })
    const c = service('c', 'sleep 5', {}, { depends_on: ['b'] })
    supervisor.configure([a, b, c], new Set())
    await supervisor.start()

    await supervisor.stop()

    const stoppedAt = (name: string): number => logs.indexOf(name, /^stopping$/)
    expect(stoppedAt('c')).toBeGreaterThan(-1)
    expect(stoppedAt('c')).toBeLessThan(stoppedAt('b'))
    expect(stoppedAt('b')).toBeLessThan(stoppedAt('a'))
    expect(supervisor.snapshot().map((info) => info.status)).toEqual(['stopped', 'stopped', 'stopped'])
    expect(supervisor.handles().size).toBe(0)
  })

  it('never starts an excluded service', async () => {
    supervisor.configure([service('on', 'sleep 5'), service('off', 'sleep 5')], new Set(['off']))

    await supervisor.start()
    await supervisor.start(['off'])
    await supervisor.restart('off')

    expect(statusOf('on')).toBe('healthy')
    expect(statusOf('off')).toBe('pending')
    expect(supervisor.snapshot().find((info) => info.name === 'off')?.excluded).toBe(true)
    expect(logs.textsFor('off')).toEqual([])
  })

  it('skips services whose autostart is false unless they are named', async () => {
    supervisor.configure([service('manual', 'sleep 5', {}, { autostart: false })], new Set())
    await supervisor.start()
    expect(statusOf('manual')).toBe('pending')

    await supervisor.start(['manual'])
    expect(statusOf('manual')).toBe('healthy')
  })

  it('emits debounced onChange batches with a fresh array each time', async () => {
    supervisor.configure([service('emit', 'sleep 5')], new Set())
    await supervisor.start()
    await waitFor(() => changes.length >= 2)

    expect(changes.length).toBeLessThan(20)
    expect(new Set(changes.map((batch) => batch)).size).toBe(changes.length)
    expect(changes.at(-1)?.[0]?.status).toBe('healthy')
  })

  it('exposes handles and persistable records, and restart bumps the counter with a new pid', async () => {
    supervisor.configure([service('svc', 'sleep 5')], new Set())
    await supervisor.start()

    const handle = supervisor.handles().get('svc')
    expect(handle?.kind).toBe('host')
    expect(handle?.pid).toBeGreaterThan(0)
    const [record] = supervisor.records()
    expect(record).toMatchObject({ name: 'svc', runtime: 'host', containerId: null, composeProject: null, restarts: 0 })
    expect(record?.pidStart).toBeGreaterThan(0)

    const firstPid = handle?.pid ?? 0
    await supervisor.restart('svc')

    expect(statusOf('svc')).toBe('healthy')
    expect(supervisor.snapshot()[0]?.restarts).toBe(1)
    expect(supervisor.handles().get('svc')?.pid).not.toBe(firstPid)
    await waitFor(() => !pidAlive(firstPid))
  })

  it('reaps what a previous daemon left behind, including services the config no longer has', async () => {
    const runner = createHostRunner()
    const sink = logs.sinkFor('ghost')
    const leftover = await runner.start({ worktreeId: 'wt-abcdef12', worktreePath: process.cwd(), projectName: 'canopy', dataDir, logs: sink }, service('ghost', 'sleep 30 & wait'))
    const previous: PreviousRecord[] = [
      { name: 'ghost', runtime: 'host', pid: leftover.pid ?? null, pidStart: leftover.pidStart ?? null, containerId: null, composeProject: null, restarts: 3 }
    ]

    await supervisor.reap(previous)

    await waitFor(() => !pidAlive(leftover.pid ?? 0))
  })

  it('restores the restart counter for a reaped service that is still configured', async () => {
    supervisor.configure([service('svc', 'sleep 5')], new Set())
    await supervisor.reap([{ name: 'svc', runtime: 'host', pid: null, pidStart: null, containerId: null, composeProject: null, restarts: 4 }])
    expect(supervisor.snapshot()[0]?.restarts).toBe(4)
  })

  it('applies sampled usage and clears it for services with no sample', async () => {
    supervisor.configure([service('a', 'sleep 5'), service('b', 'sleep 5')], new Set())
    supervisor.setUsage(new Map([['a', { cpuPct: 12.5, memMb: 64 }]]))

    expect(supervisor.snapshot()[0]).toMatchObject({ cpuPct: 12.5, memMb: 64 })
    expect(supervisor.snapshot()[1]?.cpuPct).toBeUndefined()

    supervisor.setUsage(new Map())
    expect(supervisor.snapshot()[0]?.cpuPct).toBeUndefined()
  })

  it('keeps status and restart counts across a reconfigure, and reports the new command', async () => {
    supervisor.configure([service('svc', 'sleep 5')], new Set())
    await supervisor.start()
    await supervisor.restart('svc')

    supervisor.configure([service('svc', 'sleep 6')], new Set(['svc'])) // now excluded

    const info = supervisor.snapshot()[0]
    expect(info).toMatchObject({ command: 'sleep 6', restarts: 1, excluded: true })
  })

  it('dispose stops every service and leaves no timer behind', async () => {
    supervisor.configure([service('a', 'sleep 5'), service('b', 'sleep 5')], new Set())
    await supervisor.start()
    const pids = [...supervisor.handles().values()].map((handle) => handle.pid ?? 0)
    expect(pids.every((pid) => pid > 0)).toBe(true)

    await supervisor.dispose()

    for (const pid of pids) await waitFor(() => !pidAlive(pid))
    expect(supervisor.handles().size).toBe(0)
    expect(supervisor.snapshot().every((info) => info.status === 'stopped')).toBe(true)
    const timers = (supervisor as unknown as { timers: Set<unknown> }).timers
    expect(timers.size).toBe(0)
  })

  it('routes docker and compose services to their runners', async () => {
    const docker = stubRunner('docker')
    const compose = stubRunner('compose')
    await supervisor.dispose()
    supervisor = build({ runners: { host: createHostRunner(), docker, compose } })
    supervisor.configure(
      [service('api', 'serve', { runtime: 'docker' }), service('stack', 'up', { runtime: 'compose' })],
      new Set()
    )

    await supervisor.start()

    expect(docker.calls).toContain('start:api')
    expect(compose.calls).toContain('start:stack')
    expect(supervisor.snapshot().map((info) => info.status)).toEqual(['healthy', 'healthy'])
    expect(supervisor.snapshot()[0]?.containerId).toBe('fake-api')

    await supervisor.stop()
    expect(docker.calls).toContain('stop:api')
    expect(compose.calls).toContain('stop:stack')
  })
})
