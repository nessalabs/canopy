/**
 * Port allocation for the numbers `canopywt` does not own.
 *
 * Service ports declared in `canopy.yaml` are the crate's: it keeps the registry in the
 * repository's common git dir, so every worktree and every tool sees one table. What is left
 * here is the ports Canopy allocates for things the crate has no concept of — a database fork's
 * container port — plus `record`, which mirrors the crate's answers into this table so the two
 * can never hand out the same number.
 *
 * Every named port of every worktree gets one number for its whole life:
 * the URL a developer bookmarked must survive daemon restarts, so an existing row always
 * wins and is never re-tested. New names start from a stable hash of the seed key
 * (project/branch/name) so the same branch tends to get the same number on every machine,
 * then walk forward past anything allocated or already bound.
 */
import { createServer } from 'node:net'

import type { Database } from 'better-sqlite3'

import { conflict } from '../../lib/errors'

/** How long a bind probe may take before the port counts as unusable. */
const BIND_TIMEOUT_MS = 400

interface AllocationRow {
  worktree_id: string
  name: string
  port: number
}

/** FNV-1a: tiny, dependency-free, and stable across processes and platforms. */
export function hashPort(seedKey: string, range: [number, number]): number {
  const [from, to] = range
  const lo = Math.min(from, to)
  const span = Math.abs(to - from) + 1
  let hash = 0x811c9dc5
  for (let i = 0; i < seedKey.length; i += 1) {
    hash ^= seedKey.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return lo + (hash % span)
}

/**
 * Allocations live in `port_allocations` (port is UNIQUE daemon-wide), so two worktrees of
 * two different projects can never collide.
 */
export class PortAllocator {
  constructor(
    private readonly db: Database,
    private readonly range: [number, number]
  ) {}

  /**
   * Mirrors an allocation the crate made, so database allocation walks past it.
   *
   * Two allocators over one range is how you get two services told to listen on the same port.
   * The crate is the authority for service ports; this is how that answer becomes visible to
   * the allocation that still happens here.
   */
  record(worktreeId: string, name: string, port: number): void {
    this.db
      .prepare(
        `INSERT INTO port_allocations (worktree_id, name, port, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(worktree_id, name) DO UPDATE SET port = excluded.port`
      )
      .run(worktreeId, name, port, Date.now())
  }

  /** Every named port this worktree holds. */
  allocated(worktreeId: string): Record<string, number> {
    const rows = this.db.prepare('SELECT worktree_id, name, port FROM port_allocations WHERE worktree_id = ?').all(worktreeId) as AllocationRow[]
    return Object.fromEntries(rows.map((row) => [row.name, row.port]))
  }

  /** Everything allocated on this daemon, for the host view and for conflict reporting. */
  allAllocated(): Array<{ worktreeId: string; name: string; port: number }> {
    const rows = this.db.prepare('SELECT worktree_id, name, port FROM port_allocations ORDER BY port').all() as AllocationRow[]
    return rows.map((row) => ({ worktreeId: row.worktree_id, name: row.name, port: row.port }))
  }

  /**
   * Returns the port for (worktreeId, name), allocating one on first call. Idempotent: a
   * stored allocation is handed back untouched even if something else is bound to it right
   * now (a still-running service from the previous daemon, typically).
   */
  async allocate(worktreeId: string, name: string, opts: { seedKey: string; preferred?: number; range?: [number, number] }): Promise<number> {
    const existing = this.db.prepare('SELECT port FROM port_allocations WHERE worktree_id = ? AND name = ?').get(worktreeId, name) as
      | { port: number }
      | undefined
    if (existing) return existing.port

    const [from, to] = opts.range ?? this.range
    const lo = Math.min(from, to)
    const hi = Math.max(from, to)
    const span = hi - lo + 1
    const taken = new Set((this.db.prepare('SELECT port FROM port_allocations').all() as Array<{ port: number }>).map((row) => row.port))

    const claim = (port: number): number | null => {
      try {
        this.db.prepare('INSERT INTO port_allocations (worktree_id, name, port, created_at) VALUES (?, ?, ?, ?)').run(worktreeId, name, port, Date.now())
        return port
      } catch {
        // Another allocation won the race for this number; keep walking.
        return null
      }
    }

    const preferred = opts.preferred
    if (preferred !== undefined && preferred >= lo && preferred <= hi && !taken.has(preferred) && (await this.isFree(preferred))) {
      const claimed = claim(preferred)
      if (claimed !== null) return claimed
    }

    const start = hashPort(opts.seedKey, [lo, hi])
    for (let i = 0; i < span; i += 1) {
      const port = lo + ((start - lo + i) % span)
      if (taken.has(port)) continue
      if (!(await this.isFree(port))) continue
      const claimed = claim(port)
      if (claimed !== null) return claimed
    }
    throw conflict('no_free_port', `no free port for ${name} in ${lo}-${hi}`, { worktreeId, name, range: [lo, hi] })
  }

  /** Frees one named port, or every port of the worktree when `name` is omitted (destroy). */
  release(worktreeId: string, name?: string): void {
    if (name === undefined) this.db.prepare('DELETE FROM port_allocations WHERE worktree_id = ?').run(worktreeId)
    else this.db.prepare('DELETE FROM port_allocations WHERE worktree_id = ? AND name = ?').run(worktreeId, name)
  }

  /** Can we actually listen on it? A number nobody allocated may still be taken by another app. */
  isFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = createServer()
      let settled = false
      const done = (free: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        // Keep the error listener attached: close() on a server that never bound reports
        // through its callback, and an unhandled 'error' would crash the daemon.
        server.close(() => resolve(free))
        if (!server.listening) resolve(free)
      }
      const timer = setTimeout(() => done(false), BIND_TIMEOUT_MS)
      timer.unref?.()
      // EADDRINUSE and EACCES (privileged or OS-reserved ranges) both mean "not ours".
      server.once('error', () => done(false))
      server.once('listening', () => done(true))
      try {
        server.listen(port, '127.0.0.1')
      } catch {
        done(false)
      }
    })
  }
}
