/**
 * `CanopydSupervisor` against a real `canopyd`, a real repository and real processes. The point of
 * the class is that the supervising is no longer ours, so a fake canopyd would test nothing: what
 * matters is that the binary's events and this daemon's `ServiceInfo` agree.
 */
import { existsSync, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ServiceInfo, ServiceSpec } from '@canopy/shared'

import { CanopydSupervisor } from '../../src/env/services/canopyd-supervisor'
import { pidAlive } from '../../src/env/services/runners/host'
import type { LogSink, ResolvedService } from '../../src/env/types'
import { createFixtureRepo, type FixtureRepo } from '../helpers/fixture-repo'

const hasTool = (process.env['PATH'] ?? '').split(delimiter).some((dir) => dir.length > 0 && existsSync(join(dir, 'canopyd')))

interface RecordingSink extends LogSink {
  texts(stream: 'out' | 'err' | 'sys'): string[]
}

function recordingSink(): RecordingSink {
  const lines: Array<{ stream: 'out' | 'err' | 'sys'; text: string }> = []
  return {
    texts: (stream) => lines.filter((line) => line.stream === stream).map((line) => line.text),
    out: (text) => lines.push({ stream: 'out', text }),
    err: (text) => lines.push({ stream: 'err', text }),
    sys: (text) => lines.push({ stream: 'sys', text })
  }
}

const waitFor = async (test: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!test()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** What the environment service would resolve for a service declared in the fixture's canopy.yaml. */
function resolved(repo: FixtureRepo, name: string, spec: Partial<ServiceSpec> & { run: string }): ResolvedService {
  const full: ServiceSpec = { env: {}, depends_on: [], restart: 'on-failure', autostart: true, stop_signal: 'SIGTERM', stop_timeout: '10s', ...spec }
  return { name, spec: full, runtime: 'host', command: full.run ?? '', cwd: repo.path, env: {}, ports: [], stopSignal: 'SIGTERM', stopTimeoutMs: 3000 }
}

describe.skipIf(!hasTool)('CanopydSupervisor', () => {
  let repo: FixtureRepo
  let supervisor: CanopydSupervisor | null
  let worktreeLog: RecordingSink
  let serviceLogs: Map<string, RecordingSink>
  let changes: ServiceInfo[][]

  beforeEach(async () => {
    repo = await createFixtureRepo()
    supervisor = null
    worktreeLog = recordingSink()
    serviceLogs = new Map()
    changes = []
  })

  afterEach(async () => {
    await supervisor?.dispose()
    repo.cleanup()
  })

  /** Commits `yaml` as the repo's canopy.yaml and returns a supervisor over its main checkout. */
  async function supervise(yaml: string, overrides: Record<string, string> = {}): Promise<CanopydSupervisor> {
    await repo.commit({ 'canopy.yaml': `version: 1\n${yaml}` }, 'config')
    supervisor = new CanopydSupervisor({
      branch: 'main',
      ctx: { worktreeId: 'wt-1', worktreePath: repo.path, projectName: 'fixture', dataDir: join(repo.path, '.data'), logs: worktreeLog },
      sinkFor: (service) => {
        const sink = serviceLogs.get(service) ?? recordingSink()
        serviceLogs.set(service, sink)
        return sink
      },
      onChange: (services) => changes.push(services),
      overrides: () => overrides
    })
    return supervisor
  }

  const info = (name: string): ServiceInfo => {
    const found = supervisor?.snapshot().find((svc) => svc.name === name)
    if (!found) throw new Error(`no service ${name}`)
    return found
  }

  it('starts a service, reports it healthy with its pid, and captures its output', async () => {
    const sup = await supervise('services:\n  web:\n    run: echo hello from web; sleep 60\n')
    sup.configure([resolved(repo, 'web', { run: 'echo hello from web; sleep 60' })], new Set())
    expect(info('web').status).toBe('pending')

    await sup.start()

    expect(info('web').status).toBe('healthy')
    const pid = info('web').pid
    expect(pid).toBeGreaterThan(0)
    expect(pidAlive(pid as number)).toBe(true)
    expect(info('web').startedAt).not.toBeNull()
    // The process group leader is what the resource sampler measures.
    expect(sup.handles().get('web')?.pid).toBe(pid)
    expect(sup.records()).toEqual([{ name: 'web', runtime: 'host', pid, pidStart: null, containerId: null, composeProject: null, restarts: 0 }])

    await waitFor(() => (serviceLogs.get('web')?.texts('out') ?? []).includes('hello from web'))
    expect(worktreeLog.texts('sys')).toContain(`web started (pid ${pid})`)
    await waitFor(() => changes.some((services) => services.some((svc) => svc.name === 'web' && svc.status === 'healthy')))
  })

  it('waits for a health check, and for a dependency to be serving before its dependent starts', async () => {
    const yaml = [
      'services:',
      '  api:',
      '    run: sleep 1; touch ready; sleep 60',
      '    health:',
      '      cmd: test -f ready',
      '      interval: 200ms',
      '      start_period: 0s',
      '      retries: 100',
      '  web:',
      '    run: test -f ready && sleep 60',
      '    depends_on: [api]',
      '    restart: never',
      ''
    ].join('\n')
    const sup = await supervise(yaml)
    sup.configure(
      [
        resolved(repo, 'api', { run: 'sleep 1; touch ready; sleep 60', health: { cmd: 'test -f ready', interval: '200ms', timeout: '5s', start_period: '0s', retries: 100 } }),
        resolved(repo, 'web', { run: 'test -f ready && sleep 60', depends_on: ['api'], restart: 'never' })
      ],
      new Set()
    )

    await sup.start()

    // `web` exits at once unless `ready` exists, so healthy means it was started after api served.
    expect(info('api').status).toBe('healthy')
    expect(info('api').health).toBe('cmd')
    expect(info('web').status).toBe('healthy')
    expect(changes.some((services) => services.some((svc) => svc.name === 'api' && svc.status === 'starting'))).toBe(true)
  })

  it('hands its overrides to the service without putting the values in the argument list', async () => {
    const sup = await supervise('services:\n  web:\n    run: echo "$DATABASE_URL" > seen.txt; sleep 60\n', { DATABASE_URL: 'postgres://canopy:hunter2@localhost/fork' })
    sup.configure([resolved(repo, 'web', { run: 'echo "$DATABASE_URL" > seen.txt; sleep 60' })], new Set())

    await sup.start()

    await waitFor(() => existsSync(join(repo.path, 'seen.txt')))
    expect(readFileSync(join(repo.path, 'seen.txt'), 'utf8').trim()).toBe('postgres://canopy:hunter2@localhost/fork')
    // What canopyd was launched with is logged, and the secret is not in it.
    expect(worktreeLog.texts('sys').join('\n')).not.toContain('hunter2')
  })

  it('holds a stopped service against restart: always, and brings it back when asked', async () => {
    const sup = await supervise('services:\n  web:\n    run: sleep 60\n    restart: always\n')
    sup.configure([resolved(repo, 'web', { run: 'sleep 60', restart: 'always' })], new Set())
    await sup.start()
    const first = info('web').pid as number

    await sup.stop(['web'])

    expect(info('web').status).toBe('stopped')
    expect(info('web').pid).toBeUndefined()
    expect(pidAlive(first)).toBe(false)
    // Long enough for several supervisor polls: a stop that read as a crash would be back by now.
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(info('web').status).toBe('stopped')

    await sup.start(['web'])

    expect(info('web').status).toBe('healthy')
    expect(info('web').pid).not.toBe(first)
  })

  it('restarts one service as a new process and leaves the others alone', async () => {
    const sup = await supervise('services:\n  api:\n    run: sleep 60\n  web:\n    run: sleep 60\n')
    sup.configure([resolved(repo, 'api', { run: 'sleep 60' }), resolved(repo, 'web', { run: 'sleep 60' })], new Set())
    await sup.start()
    const api = info('api').pid
    const web = info('web').pid as number

    await sup.restart('web')

    expect(info('web').status).toBe('healthy')
    expect(info('web').pid).not.toBe(web)
    expect(pidAlive(web)).toBe(false)
    expect(info('api').pid).toBe(api)
  })

  it('shows a crash as exited with its code, then restarting, and counts the restart', async () => {
    const sup = await supervise('services:\n  web:\n    run: sleep 2; exit 3\n    restart: on-failure\n')
    sup.configure([resolved(repo, 'web', { run: 'sleep 2; exit 3' })], new Set())

    await sup.start()
    await waitFor(() => info('web').restarts >= 1, 15_000)

    // Changes are debounced, so what the panel is told arrives a moment after the state moves.
    await waitFor(() => changes.some((services) => services.some((svc) => svc.status === 'restarting' && svc.exitCode === 3 && svc.restarts === 1)))
    expect(worktreeLog.texts('sys')).toContain('web exited with code 3')
    // It comes back as a new process, by canopyd's doing and not ours.
    await waitFor(() => info('web').status === 'healthy', 15_000)
  })

  it('leaves excluded and autostart: false services alone, and starts dependencies of what it is asked for', async () => {
    const yaml = 'services:\n  db:\n    run: sleep 60\n  web:\n    run: sleep 60\n    depends_on: [db]\n    autostart: false\n  worker:\n    run: sleep 60\n'
    const sup = await supervise(yaml)
    sup.configure(
      [resolved(repo, 'db', { run: 'sleep 60' }), resolved(repo, 'web', { run: 'sleep 60', depends_on: ['db'], autostart: false }), resolved(repo, 'worker', { run: 'sleep 60' })],
      new Set(['worker'])
    )

    await sup.start()
    expect(info('db').status).toBe('healthy')
    expect(info('web').status).toBe('pending')
    expect(info('worker').status).toBe('pending')
    expect(info('worker').excluded).toBe(true)

    await sup.start(['web'])
    expect(info('web').status).toBe('healthy')
  })

  it('reports a run that canopyd refuses to begin as failed, with its reason', async () => {
    // The daemon believes there is a service here; the file canopyd reads says otherwise.
    const sup = await supervise('services: {}\n')
    sup.configure([resolved(repo, 'web', { run: 'sleep 60' })], new Set())

    await sup.start()

    expect(info('web').status).toBe('failed')
    expect(info('web').lastError).toMatch(/web/)
    expect(worktreeLog.texts('err').join('\n')).toMatch(/web/)
  })

  it('stops everything when the run ends, and again when disposed', async () => {
    const sup = await supervise('services:\n  api:\n    run: sleep 60\n  web:\n    run: sleep 60\n')
    sup.configure([resolved(repo, 'api', { run: 'sleep 60' }), resolved(repo, 'web', { run: 'sleep 60' })], new Set())
    await sup.start()
    const pids = [info('api').pid as number, info('web').pid as number]

    await sup.stop()

    expect(sup.snapshot().map((svc) => svc.status)).toEqual(['stopped', 'stopped'])
    expect(pids.map(pidAlive)).toEqual([false, false])
    expect(sup.handles().size).toBe(0)

    // A second start is a fresh run, not a request to one that is gone.
    await sup.start()
    const again = info('web').pid as number
    expect(pidAlive(again)).toBe(true)
    await sup.dispose()
    expect(pidAlive(again)).toBe(false)
  })

  it('reaps whatever an earlier run left behind', async () => {
    const sup = await supervise('services:\n  web:\n    run: sleep 60\n')
    sup.configure([resolved(repo, 'web', { run: 'sleep 60' })], new Set())
    // Started outside any supervisor, the way a run that was killed outright would leave it.
    const { execa } = await import('execa')
    const up = await execa('canopyd', ['up', 'main', '--no-wait', '--json'], { cwd: repo.path })
    const pid = (JSON.parse(up.stdout) as { data: Array<{ pid: number }> }).data[0]?.pid as number
    expect(pidAlive(pid)).toBe(true)

    await sup.reap([])

    expect(pidAlive(pid)).toBe(false)
  })
})
