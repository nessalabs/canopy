/**
 * Resource accounting. Three sources, one tick:
 *   - host processes: a single `ps` per tick for the whole machine, attributed to service
 *     process groups (one `ps` for 40 services beats 40 `ps` calls).
 *   - containers: `docker stats --no-stream` through the docker helper.
 *   - the host itself: `os.cpus()` deltas.
 *
 * CPU is a delta of cumulative CPU *time* between two ticks, so the first sample of anything
 * is 0% — there is nothing to subtract from yet.
 */
import { cpus, freemem, totalmem } from 'node:os'

import { execa } from 'execa'

import type { HostSample } from '@canopy/shared'

import type { DockerHelper } from '../types'

/** One supervised service: its process-group leader pid and the key results are keyed by. */
export interface ProcessTarget {
  /** `<worktreeId>/<service>`. */
  key: string
  pid: number
}

export interface PsRow {
  pid: number
  ppid: number
  pgid: number
  rssKb: number
  cpuSeconds: number
}

interface CoreTimes {
  idle: number
  total: number
}

const round1 = (value: number): number => Math.round(value * 10) / 10

/**
 * Seconds from a `ps` TIME column. Linux prints `[DD-]HH:MM:SS`, macOS `M:SS.ss` (and
 * `HH:MM:SS` once a process passes an hour), so parse colon groups right to left.
 */
export function parseCpuTime(text: string): number {
  const trimmed = text.trim()
  if (trimmed.length === 0) return 0
  const dash = trimmed.indexOf('-')
  const days = dash > 0 ? Number(trimmed.slice(0, dash)) : 0
  const rest = dash > 0 ? trimmed.slice(dash + 1) : trimmed
  let seconds = 0
  for (const part of rest.split(':')) {
    const value = Number(part)
    if (Number.isNaN(value)) return 0
    seconds = seconds * 60 + value
  }
  return (Number.isNaN(days) ? 0 : days) * 86_400 + seconds
}

/** Rows of `ps -axo pid=,ppid=,pgid=,rss=,time=`; malformed lines are skipped, not thrown on. */
export function parsePs(stdout: string): PsRow[] {
  const rows: PsRow[] = []
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 5) continue
    const [pid, ppid, pgid, rss, time] = parts as [string, string, string, string, string]
    const row = { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), rssKb: Number(rss), cpuSeconds: parseCpuTime(time) }
    if (Number.isNaN(row.pid) || Number.isNaN(row.rssKb)) continue
    rows.push(row)
  }
  return rows
}

/** Pids of a service: its process group, plus descendants that escaped into another group. */
function groupPids(rows: PsRow[], leader: number): Set<number> {
  const pids = new Set<number>()
  const children = new Map<number, number[]>()
  for (const row of rows) {
    if (row.pgid === leader) pids.add(row.pid)
    const list = children.get(row.ppid)
    if (list) list.push(row.pid)
    else children.set(row.ppid, [row.pid])
  }
  const queue = [...pids, leader]
  while (queue.length > 0) {
    const pid = queue.pop() as number
    for (const child of children.get(pid) ?? []) {
      if (pids.has(child)) continue
      pids.add(child)
      queue.push(child)
    }
  }
  return pids
}

/**
 * Holds the previous tick's readings, so it must be a single long-lived instance per daemon
 * (the deltas are what CPU% means).
 */
export class ResourceSampler {
  private prevCpu = new Map<number, number>()
  private prevAt = 0
  private prevCores: CoreTimes[] = []
  /** macOS: bytes really available (free + inactive + speculative + purgeable), refreshed asynchronously. */
  private macAvailableBytes: number | null = null
  private macRefreshing = false

  constructor(private readonly docker: DockerHelper) {}

  /**
   * `os.freemem()` on macOS is only the "free" page count, which the kernel keeps tiny by
   * design — inactive and purgeable pages are reclaimable too. `vm_stat` has the full picture;
   * it is refreshed in the background so sampleHost() can stay synchronous.
   */
  private refreshMacMemory(): void {
    if (process.platform !== 'darwin' || this.macRefreshing) return
    this.macRefreshing = true
    void execa('vm_stat', [], { reject: false, timeout: 3000 })
      .then((result) => {
        const parsed = parseVmStat(String(result.stdout ?? ''))
        if (parsed !== null) this.macAvailableBytes = parsed
      })
      .catch(() => undefined)
      .finally(() => {
        this.macRefreshing = false
      })
  }

  /** CPU% and RSS per target, from one `ps` covering the whole machine. */
  async sampleProcesses(targets: ProcessTarget[]): Promise<Map<string, { cpuPct: number; memMb: number }>> {
    const usage = new Map<string, { cpuPct: number; memMb: number }>()
    if (targets.length === 0) return usage

    let rows: PsRow[] = []
    try {
      const result = await execa('ps', ['-axo', 'pid=,ppid=,pgid=,rss=,time='], { reject: false, timeout: 5000, maxBuffer: 16 * 1024 * 1024 })
      rows = parsePs(String(result.stdout ?? ''))
    } catch {
      rows = []
    }

    const at = Date.now()
    const elapsed = this.prevAt === 0 ? 0 : (at - this.prevAt) / 1000

    for (const target of targets) {
      const pids = groupPids(rows, target.pid)
      let rssKb = 0
      let cpuNow = 0
      let cpuBefore = 0
      for (const row of rows) {
        if (!pids.has(row.pid)) continue
        rssKb += row.rssKb
        cpuNow += row.cpuSeconds
        cpuBefore += this.prevCpu.get(row.pid) ?? 0
      }
      const cpuPct = elapsed > 0 ? Math.max(0, ((cpuNow - cpuBefore) / elapsed) * 100) : 0
      usage.set(target.key, { cpuPct: round1(cpuPct), memMb: round1(rssKb / 1024) })
    }

    // Rebuilt (not merged) so dead pids drop out instead of growing the map forever.
    this.prevCpu = new Map(rows.map((row) => [row.pid, row.cpuSeconds]))
    this.prevAt = at
    return usage
  }

  /** Container usage by id; `docker stats` is only worth spawning when containers exist. */
  async sampleContainers(ids: string[]): Promise<Map<string, { cpuPct: number; memMb: number }>> {
    if (ids.length === 0) return new Map()
    try {
      return await this.docker.stats(ids)
    } catch {
      return new Map()
    }
  }

  /**
   * Whole-machine utilization. Synchronous on purpose: `os.cpus()` is a cheap syscall and the
   * ticker wants it inline. Note macOS `freemem()` counts inactive (reclaimable) pages as
   * used, so memUsedMb reads higher there than Activity Monitor's "memory used".
   */
  sampleHost(): HostSample {
    const now: CoreTimes[] = cpus().map((core) => {
      const times = core.times
      return { idle: times.idle, total: times.user + times.nice + times.sys + times.idle + times.irq }
    })
    const previous = this.prevCores
    const cores = now.map((core, index) => {
      const before = previous[index]
      if (!before) return 0
      const total = core.total - before.total
      const idle = core.idle - before.idle
      if (total <= 0) return 0
      return round1(Math.min(100, Math.max(0, ((total - idle) / total) * 100)))
    })
    this.prevCores = now
    const memTotalMb = round1(totalmem() / 1024 / 1024)
    this.refreshMacMemory()
    const available = this.macAvailableBytes ?? freemem()
    return {
      t: Date.now(),
      cpuPct: cores.length > 0 ? round1(cores.reduce((sum, value) => sum + value, 0) / cores.length) : 0,
      cores,
      memUsedMb: round1(Math.max(0, totalmem() - available) / 1024 / 1024),
      memTotalMb
    }
  }
}

/**
 * Bytes available from `vm_stat` output: free + inactive + speculative + purgeable pages times
 * the page size in the header. Null when the output is not what we expect.
 */
export function parseVmStat(stdout: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(stdout)?.[1] ?? 0)
  if (!pageSize) return null
  const pages = (label: string): number => Number(new RegExp(`^${label}:\\s+(\\d+)`, 'm').exec(stdout)?.[1] ?? 0)
  const total = pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable')
  return total > 0 ? total * pageSize : null
}
