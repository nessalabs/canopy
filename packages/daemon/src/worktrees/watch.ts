/**
 * Change notifications for a worktree's files, so clients stop polling and refetching on a
 * timer. Nothing is watched until a client reads a worktree's files or changes — a daemon that
 * manages twenty worktrees pays for the one being looked at — and a worktree's watch goes when
 * the worktree does. One recursive OS watch covers the checkout (FSEvents on macOS, ReadDirectoryChangesW
 * on Windows; Linux would have to crawl the tree to set inotify watches, so it gets none and the
 * clients keep their timers). Bursts settle for a moment, `node_modules` and `.git` are dropped
 * before anything else looks at them, and one `git check-ignore` per burst drops the rest of
 * what git ignores, so a build writing `dist/` is not a change.
 */
import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'

import type { EventBus } from '../env/types'
import type { Repo } from '../git/repo'
import type { WorktreesService } from './service'

/** Recursive `fs.watch` is native here; elsewhere it walks the tree, which is not lean. */
export const WATCH_SUPPORTED = process.platform === 'darwin' || process.platform === 'win32'

/** How long a burst may keep extending before it is reported anyway. */
const SETTLE_MS = 250
const MAX_WAIT_MS = 1000
/** More distinct paths than this in one burst is a checkout or an install, not an edit. */
const MAX_PATHS = 500

/** Never worth a look: git's own store, and the dependency tree an install churns through. */
const NOISE = /^(node_modules|\.git)(\/|$)/
/** Files in the git dir whose change means the repository moved. `*.lock` is git mid-write. */
const GIT_NOTABLE = /^(HEAD|ORIG_HEAD|FETCH_HEAD|MERGE_HEAD|REBASE_HEAD|CHERRY_PICK_HEAD|index|packed-refs|refs(\/.*)?)$/

interface Deps {
  worktrees: Pick<WorktreesService, 'location'>
  repo: Pick<Repo, 'gitDirs' | 'checkIgnore'>
  events: EventBus
}

/** One worktree's watchers and the burst they are accumulating. */
class Watched {
  readonly watchers: FSWatcher[] = []
  pending = new Set<string>()
  git = false
  overflow = false
  timer: NodeJS.Timeout | undefined
  since: number | undefined
  closed = false

  constructor(
    readonly root: string,
    private readonly flush: (entry: Watched) => void
  ) {}

  note(path: string): void {
    if (NOISE.test(path)) return
    if (this.pending.size >= MAX_PATHS) this.overflow = true
    else this.pending.add(path)
    this.schedule()
  }

  noteGit(name: string): void {
    if (name.endsWith('.lock') || !GIT_NOTABLE.test(name)) return
    this.git = true
    this.schedule()
  }

  /** Trailing debounce with a ceiling, so a build that never stops writing still reports. */
  private schedule(): void {
    const now = Date.now()
    this.since ??= now
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(this), Math.max(0, Math.min(SETTLE_MS, this.since + MAX_WAIT_MS - now)))
  }

  /** Hands over the burst and starts the next one. */
  take(): { paths: string[]; git: boolean; overflow: boolean } {
    const burst = { paths: [...this.pending], git: this.git, overflow: this.overflow }
    this.pending = new Set()
    this.git = false
    this.overflow = false
    this.since = undefined
    this.timer = undefined
    return burst
  }

  close(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    for (const watcher of this.watchers) watcher.close()
    this.watchers.length = 0
  }
}

export class WatchService {
  private readonly watched = new Map<string, Watched>()

  constructor(private readonly deps: Deps) {
    deps.events.subscribe((event) => {
      if (event.type === 'worktree-removed') this.stop(event.worktreeId)
    })
  }

  /** Starts watching a worktree if it is not already; a no-op where watching is unsupported. */
  ensure(worktreeId: string): void {
    if (!WATCH_SUPPORTED || this.watched.has(worktreeId)) return
    const { path } = this.deps.worktrees.location(worktreeId)
    const entry = new Watched(path, (burst) => void this.flush(worktreeId, burst))
    // Registered before the async setup so a second request during it does not start another.
    this.watched.set(worktreeId, entry)
    void this.start(worktreeId, entry).catch(() => this.stop(worktreeId))
  }

  private async start(worktreeId: string, entry: Watched): Promise<void> {
    const { gitDir, commonDir } = await this.deps.repo.gitDirs(entry.root)
    if (entry.closed) return
    const onError = (): void => this.stop(worktreeId)
    const add = (path: string, recursive: boolean, listener: (name: string) => void): void => {
      try {
        const watcher = watch(path, { recursive, persistent: false }, (_event, filename) => {
          if (filename !== null) listener(filename.toString().replaceAll('\\', '/'))
        })
        watcher.on('error', onError)
        entry.watchers.push(watcher)
      } catch {
        // A directory that does not exist (no refs yet) is nothing to watch; the rest still is.
      }
    }
    add(entry.root, true, (path) => entry.note(path))
    // The git dir holds the index and HEAD; refs — the branches — live in the common dir, which
    // is the same directory for the main worktree and the repository's for a linked one.
    add(gitDir, false, (name) => entry.noteGit(name))
    if (commonDir !== gitDir) add(commonDir, false, (name) => entry.noteGit(name))
    add(join(commonDir, 'refs'), true, (name) => entry.noteGit(`refs/${name}`))
  }

  private async flush(worktreeId: string, entry: Watched): Promise<void> {
    const { paths, git, overflow } = entry.take()
    let changed = paths
    if (!overflow && paths.length > 0) {
      const ignored = await this.deps.repo.checkIgnore(entry.root, paths).catch(() => new Set<string>())
      changed = paths.filter((path) => !ignored.has(path))
    }
    if (entry.closed || (!overflow && !git && changed.length === 0)) return
    this.deps.events.emit({ type: 'files-changed', worktreeId, paths: overflow ? [] : changed, git, truncated: overflow })
  }

  stop(worktreeId: string): void {
    this.watched.get(worktreeId)?.close()
    this.watched.delete(worktreeId)
  }

  stopAll(): void {
    for (const id of [...this.watched.keys()]) this.stop(id)
  }

  /** For tests and diagnostics: which worktrees currently have watchers. */
  watching(): string[] {
    return [...this.watched.keys()]
  }
}
