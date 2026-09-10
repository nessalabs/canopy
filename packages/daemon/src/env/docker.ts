/**
 * The `docker` CLI wrapper. Deliberately not dockerode: the CLI is what the user already has
 * authenticated and it behaves identically against Docker Desktop, Colima, Rancher and
 * podman-docker, including remote contexts. Everything is text in / text out, so the parsers
 * are pure functions and testable without a daemon.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import { execa } from 'execa'

import { CANOPY_NETWORK, type ContainerSummary, type DockerHelper } from './types'

/** `docker info` is slow enough to matter on every request and stable enough to cache. */
const INFO_TTL_MS = 5000
const DEFAULT_TIMEOUT_MS = 60_000

/** Byte multipliers `docker stats` can print; decimal and binary units both appear. */
const UNITS: Record<string, number> = {
  b: 1,
  kb: 1000,
  kib: 1024,
  mb: 1000 ** 2,
  mib: 1024 ** 2,
  gb: 1000 ** 3,
  gib: 1024 ** 3,
  tb: 1000 ** 4,
  tib: 1024 ** 4
}

const round1 = (value: number): number => Math.round(value * 10) / 10

/** `12.3MiB` (the used half of a `MemUsage`) in MiB; 0 when the shape is unexpected. */
export function parseMemUsage(text: string): number {
  const used = text.split('/')[0]?.trim() ?? ''
  const match = /^([\d.]+)\s*([A-Za-z]*)$/.exec(used)
  if (!match) return 0
  const value = Number(match[1])
  if (Number.isNaN(value)) return 0
  const unit = UNITS[(match[2] ?? '').toLowerCase()] ?? 1
  return round1((value * unit) / 1024 / 1024)
}

/** One `docker stats --format '{{json .}}'` line. */
export function parseStatsLine(line: string): { id: string; cpuPct: number; memMb: number } | null {
  let row: Record<string, string>
  try {
    row = JSON.parse(line) as Record<string, string>
  } catch {
    return null
  }
  const id = row['ID'] ?? row['Container'] ?? ''
  if (!id) return null
  const cpu = Number((row['CPUPerc'] ?? '0%').replace('%', '').trim())
  return { id, cpuPct: Number.isNaN(cpu) ? 0 : round1(cpu), memMb: parseMemUsage(row['MemUsage'] ?? '') }
}

/** One `docker ps --format '{{json .}}'` line; `Labels` is a flat `k=v,k2=v2` string. */
export function parsePsLine(line: string): ContainerSummary | null {
  let row: Record<string, string>
  try {
    row = JSON.parse(line) as Record<string, string>
  } catch {
    return null
  }
  const id = row['ID'] ?? ''
  if (!id) return null
  const labels: Record<string, string> = {}
  for (const pair of (row['Labels'] ?? '').split(',')) {
    if (pair.length === 0) continue
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    labels[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  return { id, name: row['Names'] ?? '', image: row['Image'] ?? '', state: row['State'] ?? '', labels }
}

/** Absolute path of a binary on PATH, for HostInfo. */
function whichSync(bin: string): string | null {
  if (bin.includes('/')) return existsSync(bin) ? bin : null
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (dir.length === 0) continue
    const candidate = join(dir, bin)
    if (existsSync(candidate)) return candidate
  }
  return null
}

const isMissingBinary = (error: unknown): boolean => (error as { code?: string } | null)?.code === 'ENOENT'
const isDaemonDown = (text: string): boolean => /cannot connect|is the docker daemon running|permission denied while trying to connect/i.test(text)

/** Splits a stream into lines, holding the partial tail until the next chunk completes it. */
function lineSplitter(onLine: (text: string) => void): { push: (chunk: string) => void; flush: () => void } {
  let buffer = ''
  return {
    push(chunk) {
      buffer += chunk
      const parts = buffer.split('\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) onLine(part.replace(/\r$/, ''))
    },
    flush() {
      if (buffer.length > 0) onLine(buffer)
      buffer = ''
    }
  }
}

/** Creates the helper; `bin` exists so a test or an exotic setup can point at podman. */
export function createDocker(opts: { bin?: string } = {}): DockerHelper {
  const bin = opts.bin ?? 'docker'
  let cached: { at: number; value: { available: boolean; version: string | null; path: string | null } } | null = null

  const helper: DockerHelper = {
    async info() {
      if (cached && Date.now() - cached.at < INFO_TTL_MS) return cached.value
      const path = whichSync(bin)
      let value: { available: boolean; version: string | null; path: string | null } = { available: false, version: null, path }
      try {
        const result = await execa(bin, ['version', '--format', '{{.Server.Version}}'], { reject: false, timeout: 10_000 })
        const stdout = String(result.stdout ?? '').trim()
        const stderr = String(result.stderr ?? '')
        if (result.exitCode === 0 && stdout.length > 0 && !isDaemonDown(stdout)) value = { available: true, version: stdout, path }
        else if (isDaemonDown(`${stdout}\n${stderr}`)) value = { available: false, version: null, path }
      } catch (error) {
        if (!isMissingBinary(error)) value = { available: false, version: null, path }
      }
      cached = { at: Date.now(), value }
      return value
    },

    async run(args, options = {}) {
      const okCodes = options.okCodes ?? [0]
      const result = await execa(bin, args, {
        reject: false,
        cwd: options.cwd,
        env: options.env,
        input: options.input,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024
      })
      const exitCode = result.exitCode ?? 1
      const stdout = String(result.stdout ?? '')
      const stderr = String(result.stderr ?? '')
      if (!okCodes.includes(exitCode)) throw new Error(stderr.trim() || `docker ${args[0] ?? ''} exited with ${exitCode}`)
      return { stdout, stderr, exitCode }
    },

    stream(args, onLine, options = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn(bin, args, {
          cwd: options.cwd,
          env: options.env ? { ...process.env, ...options.env } : process.env,
          stdio: ['ignore', 'pipe', 'pipe']
        })
        const out = lineSplitter((text) => onLine('out', text))
        const err = lineSplitter((text) => onLine('err', text))
        child.stdout?.setEncoding('utf8')
        child.stderr?.setEncoding('utf8')
        child.stdout?.on('data', (chunk: string) => out.push(chunk))
        child.stderr?.on('data', (chunk: string) => err.push(chunk))
        const abort = (): void => {
          child.kill('SIGTERM')
        }
        options.signal?.addEventListener('abort', abort, { once: true })
        child.once('error', (error) => {
          options.signal?.removeEventListener('abort', abort)
          reject(error)
        })
        child.once('close', (code) => {
          options.signal?.removeEventListener('abort', abort)
          out.flush()
          err.flush()
          resolve({ exitCode: code })
        })
      })
    },

    async ps(labels, options = {}) {
      const args = ['ps', '--format', '{{json .}}']
      if (options.all !== false) args.push('--all')
      for (const [key, value] of Object.entries(labels)) args.push('--filter', `label=${key}=${value}`)
      const { stdout } = await helper.run(args)
      return stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map(parsePsLine)
        .filter((summary): summary is ContainerSummary => summary !== null)
    },

    async inspect(idOrName) {
      try {
        const { stdout } = await helper.run(['inspect', idOrName])
        const parsed = JSON.parse(stdout) as unknown
        return Array.isArray(parsed) ? ((parsed[0] as Record<string, unknown> | undefined) ?? null) : (parsed as Record<string, unknown>)
      } catch {
        return null
      }
    },

    async remove(idOrName, options = {}) {
      const stopTimeout = String(options.stopTimeoutSec ?? 5)
      // Both calls are best-effort: "No such container" is the success case for a teardown
      // that already ran, and there is nothing useful to do about any other failure here.
      await helper.run(['stop', '-t', stopTimeout, idOrName], { okCodes: [0, 1] }).catch(() => undefined)
      const rmArgs = ['rm', '-f']
      if (options.volumes) rmArgs.push('-v')
      await helper.run([...rmArgs, idOrName], { okCodes: [0, 1] }).catch(() => undefined)
    },

    async stats(ids) {
      const usage = new Map<string, { cpuPct: number; memMb: number }>()
      if (ids.length === 0) return usage
      const { stdout } = await helper.run(['stats', '--no-stream', '--format', '{{json .}}', ...ids], { timeoutMs: 20_000 })
      for (const line of stdout.split('\n')) {
        const row = parseStatsLine(line.trim())
        if (!row) continue
        usage.set(row.id, { cpuPct: row.cpuPct, memMb: row.memMb })
        // Callers hold full ids; `docker stats` reports the 12-char short form.
        const requested = ids.find((id) => id.startsWith(row.id))
        if (requested && requested !== row.id) usage.set(requested, { cpuPct: row.cpuPct, memMb: row.memMb })
      }
      return usage
    },

    async ensureImage(image, onLine) {
      const local = await helper.run(['image', 'inspect', image], { okCodes: [0, 1] })
      if (local.exitCode === 0) return
      const result = await helper.stream(['pull', image], (_stream, text) => onLine?.(text))
      if (result.exitCode !== 0) throw new Error(`docker pull ${image} failed`)
    },

    async ensureNetwork(name = CANOPY_NETWORK) {
      const existing = await helper.run(['network', 'inspect', name], { okCodes: [0, 1] })
      if (existing.exitCode === 0) return name
      // A concurrent create is fine: the second one fails with "already exists".
      await helper.run(['network', 'create', '--driver', 'bridge', name], { okCodes: [0, 1] }).catch(() => undefined)
      return name
    }
  }

  return helper
}
