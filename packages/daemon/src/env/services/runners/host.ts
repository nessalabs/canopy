/**
 * Host runner: the service is a plain process in its own process group.
 *
 * Two things make supervision safe. First, `detached: true` gives the shell its own group so a
 * `npm run dev` that forks half a dozen children dies whole — killing the group, not just the pid
 * we spawned, is the only way to avoid orphaned dev servers holding a port. Second, we remember
 * the kernel start time of the pid: after a daemon restart a recorded pid may have been recycled
 * by an unrelated program, and `kill(-pid)` on a stranger is the worst bug this subsystem could
 * have. Every kill path therefore checks pid *and* start time before it signals anything.
 */
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

import { ApiError } from '../../../lib/errors'
import type { ResolvedService, RunContext, RunningHandle, ServiceRunner } from '../../types'

const execFileAsync = promisify(execFile)

/** Start times are second-resolution (`ps`), so compare with a tolerance rather than for equality. */
const START_TOLERANCE_SEC = 2

/** How long `reap` waits for a leftover process to honour SIGTERM before it escalates. */
const REAP_GRACE_MS = 3000

/** A single log line longer than this is flushed unterminated: a runaway writer must not grow the buffer forever. */
const MAX_LINE_BYTES = 64 * 1024

/**
 * Seconds since epoch the process started, or null when it cannot be read (gone, or `ps` unusable).
 * `ps -o lstart=` is the portable answer: macOS has no /proc and Linux's /proc/<pid>/stat starttime
 * needs the boot time and clock ticks to become an absolute date.
 */
export async function processStartTime(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 5000 })
    const text = stdout.trim().replace(/\s+/g, ' ')
    if (!text) return null
    const parsed = Date.parse(text)
    return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000)
  } catch {
    return null
  }
}

/** Whether the pid exists at all (signal 0 probes without delivering). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means it exists but belongs to somebody else — still "alive" for our purposes.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Signals the whole process group, falling back to the bare pid when the process never became a
 * group leader (it was not spawned detached, or the group is already empty). Returns whether a
 * signal was delivered; a vanished process (ESRCH) is success, not an error.
 */
export function killGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false
  }
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

/** Polls until the pid is gone or the deadline passes; true when it exited. */
export async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return !pidAlive(pid)
}

/** True when the pid is alive and (as far as we can tell) still the process we started. */
async function isOurProcess(pid: number, pidStart: number | null | undefined): Promise<boolean> {
  if (!pidAlive(pid)) return false
  if (pidStart === null || pidStart === undefined) return true
  const current = await processStartTime(pid)
  // Unreadable start time with a recorded one: refuse to claim the pid rather than risk a stranger.
  if (current === null) return false
  return Math.abs(current - pidStart) <= START_TOLERANCE_SEC
}

/** Splits a byte stream into lines, holding the partial tail until the next chunk (or the flush). */
function lineBuffer(emit: (text: string) => void): { push(chunk: string): void; flush(): void } {
  let buffer = ''
  return {
    push(chunk) {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        emit(buffer.slice(0, index).replace(/\r$/, ''))
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
      }
      if (buffer.length > MAX_LINE_BYTES) {
        emit(buffer)
        buffer = ''
      }
    },
    flush() {
      if (buffer.length === 0) return
      emit(buffer.replace(/\r$/, ''))
      buffer = ''
    }
  }
}

/** Supervises services as host processes. Stateless: everything it needs is on the handle. */
export function createHostRunner(): ServiceRunner {
  return {
    kind: 'host',

    async start(ctx: RunContext, service: ResolvedService): Promise<RunningHandle> {
      const child = spawn('/bin/sh', ['-c', service.command], {
        cwd: service.cwd,
        env: { ...process.env, ...service.env },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const pid = child.pid
      if (pid === undefined) throw new ApiError(500, 'service_spawn_failed', `could not spawn ${service.name}`)

      const out = lineBuffer((text) => ctx.logs.out(text))
      const err = lineBuffer((text) => ctx.logs.err(text))
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => out.push(chunk))
      child.stderr?.on('data', (chunk: string) => err.push(chunk))
      child.on('error', (error) => ctx.logs.sys(`spawn error: ${error.message}`))

      const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        child.on('exit', (code, signal) => {
          out.flush()
          err.flush()
          resolve({ code, signal })
        })
        // stdout can still drain after 'exit'; 'close' is the real end of the pipes.
        child.on('close', () => {
          out.flush()
          err.flush()
        })
      })

      ctx.logs.sys(`started pid ${pid}: ${service.command}`)
      const pidStart = await processStartTime(pid)
      return { kind: 'host', pid, ...(pidStart === null ? {} : { pidStart }), exited }
    },

    async stop(handle: RunningHandle, service: ResolvedService, ctx: RunContext): Promise<void> {
      const pid = handle.pid
      if (pid === undefined) return
      if (!(await isOurProcess(pid, handle.pidStart))) return

      ctx.logs.sys(`stopping pid ${pid} with ${service.stopSignal}`)
      killGroup(pid, service.stopSignal)
      const gone = await Promise.race([handle.exited.then(() => true), waitForExit(pid, service.stopTimeoutMs)])
      if (gone) return

      ctx.logs.sys(`pid ${pid} ignored ${service.stopSignal} after ${service.stopTimeoutMs}ms — SIGKILL`)
      killGroup(pid, 'SIGKILL')
      await waitForExit(pid, 2000)
    },

    async alive(handle: RunningHandle): Promise<boolean> {
      if (handle.pid === undefined) return false
      return isOurProcess(handle.pid, handle.pidStart)
    },

    async reap(ctx: RunContext, service: ResolvedService, previous: Pick<RunningHandle, 'pid' | 'pidStart' | 'containerId' | 'composeProject'>): Promise<void> {
      const pid = previous.pid
      if (pid === undefined) return
      try {
        if (!(await isOurProcess(pid, previous.pidStart))) return
        ctx.logs.sys(`reaping leftover ${service.name} pid ${pid}`)
        killGroup(pid, 'SIGTERM')
        if (await waitForExit(pid, REAP_GRACE_MS)) return
        killGroup(pid, 'SIGKILL')
        await waitForExit(pid, 2000)
      } catch {
        // reap runs on boot and on destroy: it may never be the reason either fails.
      }
    }
  }
}
