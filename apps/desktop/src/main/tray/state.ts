/**
 * The menu-bar's view of the daemon, owned by the main process rather than a window: the icon
 * has to say what is running whether or not the panel — or the app window — is open.
 *
 * One HTTP client plus one `/events` SSE subscription keep `projects` and `worktrees` fresh;
 * everything the panel renders is a plain wire type, so no extra contract sits between them.
 * A dropped stream (daemon restarted, laptop slept, canopyd never started) is not an error
 * state to recover from by hand: the loop backs off and reconnects, and `readDaemonConnection`
 * is re-read every attempt so the tray picks up a daemon that starts later.
 */
import { createClient, type CanopyClient, type CanopyEvent } from '@canopy/shared'

import type { TraySnapshot } from '../../shared/tray'
import { readDaemonConnection } from '../daemon-connection'

const BACKOFF_MS = [1000, 2000, 4000, 8000, 15_000]

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export class TrayState {
  private snap: TraySnapshot = { status: 'connecting', error: null, projects: [], worktrees: [], machine: null }
  private readonly listeners = new Set<(snapshot: TraySnapshot) => void>()
  private client: CanopyClient | null = null
  private stream: AbortController | null = null
  private sleeping: { timer: NodeJS.Timeout; wake: () => void } | null = null
  private attempt = 0
  private stopped = false
  /** Coalesces the refetches several events in one burst would otherwise each trigger. */
  private refetching: Promise<void> | null = null

  start(): void {
    void this.run()
  }

  dispose(): void {
    this.stopped = true
    this.stream?.abort()
    this.sleeping?.wake()
    this.listeners.clear()
  }

  snapshot(): TraySnapshot {
    return this.snap
  }

  subscribe(listener: (snapshot: TraySnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** The connected client, for the panel's actions. Throws the message the panel should show. */
  api(): CanopyClient {
    if (!this.client) throw new Error(this.snap.error ?? 'canopyd is not running')
    return this.client
  }

  /**
   * Pulls projects and worktrees again. Actions call this so the panel updates immediately
   * instead of waiting for the event the daemon will also send.
   */
  refresh(): Promise<void> {
    if (this.refetching) return this.refetching
    const client = this.client
    if (!client) return Promise.resolve()
    this.refetching = (async () => {
      try {
        const [projects, worktrees] = await Promise.all([client.listProjects(), client.listWorktrees()])
        if (this.client === client) this.emit({ projects, worktrees })
      } catch {
        // The stream loop owns connection failures; a lost refetch just leaves stale rows.
      } finally {
        this.refetching = null
      }
    })()
    return this.refetching
  }

  /** Skips the remaining backoff — the panel's "try again" and its first open. */
  retryNow(): void {
    this.attempt = 0
    this.sleeping?.wake()
  }

  private emit(patch: Partial<TraySnapshot>): void {
    this.snap = { ...this.snap, ...patch }
    for (const listener of this.listeners) listener(this.snap)
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const connection = readDaemonConnection()
      if (!connection) {
        this.drop('canopyd is not running')
        await this.backoff()
        continue
      }
      const client = createClient({ baseUrl: connection.url, token: connection.token })
      try {
        await this.follow(client)
        // A stream that ends cleanly means the daemon closed it; reconnect like any other drop.
        this.drop('canopyd closed the connection')
      } catch (error) {
        this.drop(message(error))
      }
      await this.backoff()
    }
  }

  /** Seeds the snapshot, then applies events until the stream ends or fails. */
  private async follow(client: CanopyClient): Promise<void> {
    // The machine's size comes from /host rather than the sample stream: cores and total memory
    // are facts, not readings, and the meters need them before any tick lands.
    const [projects, worktrees, host] = await Promise.all([client.listProjects(), client.listWorktrees(), client.host()])
    const stream = new AbortController()
    this.stream = stream
    this.client = client
    this.attempt = 0
    this.emit({ status: 'connected', error: null, projects, worktrees, machine: { cores: host.cores, memMb: host.memMb } })
    try {
      for await (const event of client.events(undefined, stream.signal)) this.apply(event)
    } finally {
      stream.abort()
      if (this.stream === stream) this.stream = null
    }
  }

  private apply(event: CanopyEvent): void {
    switch (event.type) {
      case 'environment': {
        const worktrees = this.snap.worktrees.map((worktree) => (worktree.id === event.worktreeId ? { ...worktree, environment: event.environment } : worktree))
        // An environment for a worktree the tray has never seen means the list is behind.
        if (worktrees.some((worktree) => worktree.id === event.worktreeId)) this.emit({ worktrees })
        else void this.refresh()
        return
      }
      case 'worktree-removed':
        this.emit({ worktrees: this.snap.worktrees.filter((worktree) => worktree.id !== event.worktreeId) })
        return
      case 'worktrees-changed':
      case 'project-changed':
      case 'reset':
        void this.refresh()
        return
      // `hello` only carries the resume cursor. Both sampling events are ignored: `host` is
      // whole-machine, which the panel does not show, and per-worktree `resources` samples are
      // already folded into each ServiceInfo's cpuPct/memMb.
      default:
        return
    }
  }

  private drop(error: string): void {
    this.client = null
    this.stream?.abort()
    this.stream = null
    // Every backoff tick lands here while canopyd is down; only a change is worth telling anyone.
    if (this.snap.status === 'offline' && this.snap.error === error) return
    this.emit({ status: 'offline', error })
  }

  /** Waits out the backoff for this attempt, unless `retryNow` cuts it short. */
  private backoff(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)] as number
    this.attempt += 1
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        this.sleeping = null
        resolve()
      }
      const timer = setTimeout(done, delay)
      this.sleeping = { timer, wake: done }
    })
  }
}
