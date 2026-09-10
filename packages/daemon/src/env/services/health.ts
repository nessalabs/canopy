/**
 * Health probing, resolved once at configure time and executed by the supervisor's poll loop.
 *
 * The canopy.yaml check is templated (`http: http://localhost:${ports.web}/healthz`), so the
 * target has to be interpolated with the worktree's allocated ports *before* the first probe —
 * doing it per tick would re-render the same string thousands of times. `probe` never throws:
 * a failing probe is data (the service is unhealthy), not an error, and an exception escaping
 * into the supervisor's timer chain would silently stop supervising the service.
 */
import { execa } from 'execa'
import { connect } from 'node:net'

import { parseDuration, type HealthCheck } from '@canopy/shared'

export interface ResolvedHealth {
  kind: 'none' | 'http' | 'tcp' | 'cmd'
  /** Interpolated URL, port number as a string, or shell command. Empty for `none`. */
  target: string
  intervalMs: number
  timeoutMs: number
  retries: number
  startPeriodMs: number
}

const DEFAULTS = { intervalMs: 3000, timeoutMs: 3000, retries: 10, startPeriodMs: 0 }

/** Durations are validated by the schema, but hand-built specs reach us in tests and in reconcile. */
const duration = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback
  try {
    return parseDuration(value)
  } catch {
    return fallback
  }
}

/** Flattens a `HealthCheck` into the shape the poll loop needs, with every template already rendered. */
export function resolveHealth(spec: HealthCheck | undefined, interpolateFn: (text: string) => string): ResolvedHealth {
  if (!spec) return { kind: 'none', target: '', ...DEFAULTS }
  const timing = {
    intervalMs: duration(spec.interval, DEFAULTS.intervalMs),
    timeoutMs: duration(spec.timeout, DEFAULTS.timeoutMs),
    retries: spec.retries ?? DEFAULTS.retries,
    startPeriodMs: duration(spec.start_period, DEFAULTS.startPeriodMs)
  }
  if (spec.http) return { kind: 'http', target: interpolateFn(spec.http), ...timing }
  if (spec.tcp !== undefined) return { kind: 'tcp', target: interpolateFn(String(spec.tcp)), ...timing }
  if (spec.cmd) return { kind: 'cmd', target: interpolateFn(spec.cmd), ...timing }
  return { kind: 'none', target: '', ...timing }
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))

async function probeHttp(target: string, timeoutMs: number): Promise<{ ok: boolean; detail?: string }> {
  try {
    // `redirect: 'manual'` keeps a 302 from a login wall counting as healthy (3xx < 400) without
    // chasing it, which would time out against services that redirect to an external host.
    const response = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
    void response.body?.cancel().catch(() => {})
    return response.status < 400 ? { ok: true } : { ok: false, detail: `HTTP ${response.status}` }
  } catch (error) {
    return { ok: false, detail: reason(error) }
  }
}

function probeTcp(target: string, timeoutMs: number): Promise<{ ok: boolean; detail?: string }> {
  const port = Number.parseInt(target, 10)
  if (!Number.isFinite(port) || port <= 0) return Promise.resolve({ ok: false, detail: `bad port "${target}"` })
  return new Promise((resolve) => {
    let settled = false
    const done = (result: { ok: boolean; detail?: string }): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }
    const socket = connect({ host: '127.0.0.1', port })
    socket.setTimeout(timeoutMs)
    socket.on('connect', () => done({ ok: true }))
    socket.on('timeout', () => done({ ok: false, detail: `timeout after ${timeoutMs}ms` }))
    socket.on('error', (error) => done({ ok: false, detail: reason(error) }))
  })
}

async function probeCmd(target: string, ctx: { cwd: string; env: Record<string, string> }, timeoutMs: number): Promise<{ ok: boolean; detail?: string }> {
  try {
    const result = await execa('/bin/sh', ['-c', target], {
      cwd: ctx.cwd,
      env: { ...process.env, ...ctx.env },
      reject: false,
      timeout: timeoutMs,
      all: true
    })
    if (result.exitCode === 0) return { ok: true }
    const output = String(result.all ?? result.stderr ?? '').trim().split('\n').pop() ?? ''
    return { ok: false, detail: output || `exit ${result.exitCode ?? 'timeout'}` }
  } catch (error) {
    return { ok: false, detail: reason(error) }
  }
}

/** Runs one check. Resolves `{ ok: false, detail }` for every failure mode, including timeouts. */
export async function probe(health: ResolvedHealth, ctx: { cwd: string; env: Record<string, string> }): Promise<{ ok: boolean; detail?: string }> {
  switch (health.kind) {
    case 'none':
      return { ok: true }
    case 'http':
      return probeHttp(health.target, health.timeoutMs)
    case 'tcp':
      return probeTcp(health.target, health.timeoutMs)
    case 'cmd':
      return probeCmd(health.target, ctx, health.timeoutMs)
  }
}
