import { afterEach, describe, expect, it } from 'vitest'

import { createHostRunner, killGroup, pidAlive, processStartTime, waitForExit } from '../../src/env/services/runners/host'
import type { LogSink, ResolvedService, RunContext, RunningHandle } from '../../src/env/types'

interface RecordingSink extends LogSink {
  lines: Array<{ stream: 'out' | 'err' | 'sys'; text: string }>
  texts(stream: 'out' | 'err' | 'sys'): string[]
}

function recordingSink(): RecordingSink {
  const lines: Array<{ stream: 'out' | 'err' | 'sys'; text: string }> = []
  return {
    lines,
    texts: (stream) => lines.filter((line) => line.stream === stream).map((line) => line.text),
    out: (text) => lines.push({ stream: 'out', text }),
    err: (text) => lines.push({ stream: 'err', text }),
    sys: (text) => lines.push({ stream: 'sys', text })
  }
}

const contextWith = (logs: LogSink): RunContext => ({ worktreeId: 'wt-1', worktreePath: process.cwd(), projectName: 'canopy', dataDir: '/tmp/canopy-test', logs })

function service(command: string, overrides: Partial<ResolvedService> = {}): ResolvedService {
  return {
    name: 'app',
    spec: { run: command, env: {}, depends_on: [], restart: 'never', autostart: true, stop_signal: 'SIGTERM', stop_timeout: '10s' },
    runtime: 'host',
    command,
    cwd: process.cwd(),
    env: {},
    ports: [],
    stopSignal: 'SIGTERM',
    stopTimeoutMs: 3000,
    ...overrides
  }
}

const waitFor = async (test: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await test()) return
    await new Promise((done) => setTimeout(done, 25))
  }
  throw new Error('timed out waiting for condition')
}

describe('host runner', () => {
  const runner = createHostRunner()
  const started: RunningHandle[] = []

  afterEach(async () => {
    for (const handle of started.splice(0)) if (handle.pid) killGroup(handle.pid, 'SIGKILL')
  })

  const start = async (command: string, overrides?: Partial<ResolvedService>): Promise<{ handle: RunningHandle; logs: RecordingSink; svc: ResolvedService }> => {
    const logs = recordingSink()
    const svc = service(command, overrides)
    const handle = await runner.start(contextWith(logs), svc)
    started.push(handle)
    return { handle, logs, svc }
  }

  it('streams stdout and stderr as lines, records pid and start time, and reports alive', async () => {
    const { handle, logs } = await start(`node -e "setInterval(() => console.log('tick'), 30); setTimeout(() => console.error('boom'), 60)"`)

    expect(handle.kind).toBe('host')
    expect(handle.pid).toBeGreaterThan(0)
    expect(handle.pidStart).toBeGreaterThan(0)
    expect(logs.texts('sys')[0]).toMatch(/^started pid \d+: node -e/)
    expect(await runner.alive(handle)).toBe(true)

    await waitFor(() => logs.texts('out').filter((text) => text === 'tick').length >= 2)
    await waitFor(() => logs.texts('err').includes('boom'))
    // Lines are split, never chunked: no entry may contain a newline.
    expect(logs.lines.every((line) => !line.text.includes('\n'))).toBe(true)
  })

  it('flushes an unterminated final line when the process exits', async () => {
    const { handle, logs } = await start(`printf 'no-newline-here'`)
    await handle.exited
    await waitFor(() => logs.texts('out').includes('no-newline-here'))
  })

  it('resolves exited with the exit code', async () => {
    const { handle } = await start('exit 3')
    await expect(handle.exited).resolves.toMatchObject({ code: 3, signal: null })
    await waitFor(async () => !(await runner.alive(handle)))
  })

  it('stop kills the whole process group, not just the shell', async () => {
    // The shell backgrounds a grandchild and waits; only a group kill takes both down.
    const { handle, logs, svc } = await start('sleep 30 & echo $!; wait')
    await waitFor(() => logs.texts('out').length > 0)
    const grandchild = Number.parseInt(logs.texts('out')[0] ?? '', 10)
    expect(grandchild).toBeGreaterThan(0)
    expect(pidAlive(grandchild)).toBe(true)

    await runner.stop(handle, svc, contextWith(logs))

    expect(await runner.alive(handle)).toBe(false)
    expect(pidAlive(handle.pid ?? 0)).toBe(false)
    await waitFor(() => !pidAlive(grandchild))
    expect(logs.texts('sys').some((text) => text.includes('stopping pid'))).toBe(true)
  })

  it('escalates to SIGKILL when the process ignores the stop signal', async () => {
    const { handle, logs, svc } = await start(`node -e "process.on('SIGTERM', () => {}); console.log('armed'); setInterval(() => {}, 1000)"`, { stopTimeoutMs: 500 })
    // Wait for the handler to be installed: a SIGTERM during node's startup would just kill it.
    await waitFor(() => logs.texts('out').includes('armed'))

    await runner.stop(handle, svc, contextWith(logs))

    expect(pidAlive(handle.pid ?? 0)).toBe(false)
    expect(logs.texts('sys').some((text) => text.includes('SIGKILL'))).toBe(true)
  })

  it('refuses a handle whose recorded start time does not match the live pid', async () => {
    const { handle, logs, svc } = await start('sleep 30')
    const impostor: RunningHandle = { ...handle, pidStart: (handle.pidStart ?? 0) - 120 }

    expect(await runner.alive(impostor)).toBe(false)
    // …and a stop against the mismatched handle must not signal the innocent pid.
    await runner.stop(impostor, svc, contextWith(logs))
    expect(pidAlive(handle.pid ?? 0)).toBe(true)

    await runner.stop(handle, svc, contextWith(logs))
    expect(pidAlive(handle.pid ?? 0)).toBe(false)
  })

  it('reap kills a process a previous daemon left behind, and spares a recycled pid', async () => {
    const { handle, logs, svc } = await start('sleep 30 & wait')
    const pid = handle.pid ?? 0
    const ctx = contextWith(logs)

    await runner.reap(ctx, svc, { pid, pidStart: (handle.pidStart ?? 0) + 500 })
    expect(pidAlive(pid)).toBe(true)

    await runner.reap(ctx, svc, { pid, pidStart: handle.pidStart })
    expect(pidAlive(pid)).toBe(false)
    expect(logs.texts('sys').some((text) => text.includes('reaping leftover'))).toBe(true)
  })

  it('reap never throws for a pid that no longer exists', async () => {
    const logs = recordingSink()
    await expect(runner.reap(contextWith(logs), service('true'), { pid: 999_999, pidStart: 1 })).resolves.toBeUndefined()
  })

  it('processStartTime and waitForExit behave for dead pids', async () => {
    expect(await processStartTime(999_999)).toBeNull()
    expect(await waitForExit(999_999, 200)).toBe(true)
    expect(killGroup(999_999, 'SIGTERM')).toBe(false)
    expect(await processStartTime(process.pid)).toBeGreaterThan(0)
  })
})
