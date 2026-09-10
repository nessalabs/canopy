/**
 * One SSE subscription per app to the daemon's event stream. Environment events patch the
 * react-query cache in place (no refetch); resource/host samples land in a small external
 * store the Resources tab and Command Center read with useSyncExternalStore. Reconnects with
 * backoff and resumes from the last seq; a `reset` (buffer miss) invalidates everything.
 */
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import type { CanopyEvent, HostSample, ResourceSample, Worktree, WorktreeEnvironment } from '@canopy/shared'

import { useApi } from '../providers/api'
import { setDaemonCapabilities } from './daemon-capabilities'
import { keys } from './query-keys'

const HISTORY = 90

class SampleStore {
  private readonly byWorktree = new Map<string, ResourceSample[]>()
  private host: HostSample[] = []
  private readonly listeners = new Set<() => void>()
  private version = 0

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Changes on every sample so useSyncExternalStore re-renders; selectors read the maps. */
  getVersion = (): number => this.version

  samplesOf(worktreeId: string): ResourceSample[] {
    return this.byWorktree.get(worktreeId) ?? EMPTY_SAMPLES
  }

  hostSamples(): HostSample[] {
    return this.host
  }

  pushSample(worktreeId: string, sample: ResourceSample): void {
    const current = this.byWorktree.get(worktreeId) ?? []
    if (current.at(-1)?.t === sample.t) return
    this.byWorktree.set(worktreeId, current.length >= HISTORY ? [...current.slice(1), sample] : [...current, sample])
    this.bump()
  }

  pushHost(sample: HostSample): void {
    if (this.host.at(-1)?.t === sample.t) return
    this.host = this.host.length >= HISTORY ? [...this.host.slice(1), sample] : [...this.host, sample]
    this.bump()
  }

  /** Backfill from GET /resources — older samples first, dedup by timestamp. */
  seed(worktreeId: string, samples: ResourceSample[], host: HostSample[]): void {
    const current = this.byWorktree.get(worktreeId) ?? []
    const known = new Set(current.map((s) => s.t))
    const merged = [...samples.filter((s) => !known.has(s.t)), ...current].sort((a, b) => a.t - b.t).slice(-HISTORY)
    this.byWorktree.set(worktreeId, merged)
    if (this.host.length === 0 && host.length > 0) this.host = host.slice(-HISTORY)
    this.bump()
  }

  drop(worktreeId: string): void {
    if (this.byWorktree.delete(worktreeId)) this.bump()
  }

  private bump(): void {
    this.version += 1
    for (const listener of this.listeners) listener()
  }
}

const EMPTY_SAMPLES: ResourceSample[] = []

export type ConnectionState = 'connecting' | 'live' | 'reconnecting'

interface EventsContextValue {
  samples: SampleStore
  state: ConnectionState
}

const EventsContext = createContext<EventsContextValue | null>(null)

/** Applies one environment update to every cached copy of the worktree. */
function patchEnvironment(queryClient: QueryClient, worktreeId: string, environment: WorktreeEnvironment): void {
  queryClient.setQueryData<Worktree>(keys.worktree(worktreeId), (current) => (current ? { ...current, environment } : current))
  queryClient.setQueryData<Worktree[]>(keys.worktrees, (current) => current?.map((wt) => (wt.id === worktreeId ? { ...wt, environment } : wt)))
}

function applyEvent(queryClient: QueryClient, samples: SampleStore, event: CanopyEvent): void {
  switch (event.type) {
    case 'environment':
      patchEnvironment(queryClient, event.worktreeId, event.environment)
      return
    case 'worktree-removed':
      samples.drop(event.worktreeId)
      queryClient.setQueryData<Worktree[]>(keys.worktrees, (current) => current?.filter((wt) => wt.id !== event.worktreeId))
      void queryClient.invalidateQueries({ queryKey: keys.worktrees })
      return
    case 'worktrees-changed':
      void queryClient.invalidateQueries({ queryKey: keys.worktrees })
      // A commit made in another client moves HEAD, so the diff and the log are stale too. The
      // event is rare (create, destroy, sync, commit), so the extra prefixes cost nothing while
      // nothing is happening.
      void queryClient.invalidateQueries({ queryKey: ['diff-files'] })
      void queryClient.invalidateQueries({ queryKey: ['log'] })
      return
    case 'project-changed':
      void queryClient.invalidateQueries({ queryKey: keys.projects })
      void queryClient.invalidateQueries({ queryKey: keys.projectConfig(event.projectId) })
      void queryClient.invalidateQueries({ queryKey: keys.projectEnvironment(event.projectId) })
      void queryClient.invalidateQueries({ queryKey: keys.projectSettings(event.projectId) })
      void queryClient.invalidateQueries({ queryKey: keys.projectWtToml(event.projectId) })
      return
    case 'resources':
      samples.pushSample(event.worktreeId, event.sample)
      return
    case 'host':
      samples.pushHost(event.sample)
      return
    case 'files-changed': {
      const id = event.worktreeId
      // A burst too big to list: everything read from this worktree may be stale.
      if (event.truncated) {
        void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[1] === id && query.queryKey[0] !== 'worktree' })
        return
      }
      // Any edit can change what git status says; the log only moves with the repository.
      void queryClient.invalidateQueries({ queryKey: ['diff-files', id] })
      if (event.git) void queryClient.invalidateQueries({ queryKey: keys.log(id) })
      if (event.paths.length === 0) return
      const paths = new Set(event.paths)
      for (const path of paths) void queryClient.invalidateQueries({ queryKey: keys.fileContents(id, path) })
      void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'file-patch' && query.queryKey[1] === id && paths.has(query.queryKey[3] as string) })
      // A save may be a create or a delete; the listings are cheap to read again.
      void queryClient.invalidateQueries({ queryKey: keys.worktreeFiles(id) })
      void queryClient.invalidateQueries({ queryKey: ['tree', id] })
      return
    }
    case 'reset':
      void queryClient.invalidateQueries()
      return
    case 'hello':
      setDaemonCapabilities({ watch: event.watch === true })
      return
  }
}

export function CanopyEventsProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const api = useApi()
  const queryClient = useQueryClient()
  const samples = useMemo(() => new SampleStore(), [])
  const [state, setState] = useState<ConnectionState>('connecting')
  const seq = useRef<number | undefined>(undefined)

  useEffect(() => {
    const controller = new AbortController()
    let attempt = 0
    let stopped = false

    const run = async (): Promise<void> => {
      while (!stopped) {
        try {
          for await (const event of api.events(seq.current, controller.signal)) {
            attempt = 0
            setState('live')
            seq.current = event.seq
            applyEvent(queryClient, samples, event)
          }
        } catch {
          // fall through to reconnect
        }
        if (stopped) return
        setState('reconnecting')
        // The stream ended or dropped: everything may have moved — refetch, then resume.
        void queryClient.invalidateQueries({ queryKey: keys.worktrees })
        attempt += 1
        const delay = Math.min(15_000, 500 * 2 ** Math.min(attempt, 5)) + Math.random() * 300
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
    void run()

    return () => {
      stopped = true
      controller.abort()
    }
  }, [api, queryClient, samples])

  const value = useMemo(() => ({ samples, state }), [samples, state])
  return <EventsContext.Provider value={value}>{children}</EventsContext.Provider>
}

function useEvents(): EventsContextValue {
  const value = useContext(EventsContext)
  if (!value) throw new Error('useEvents must be used inside <CanopyEventsProvider>')
  return value
}

export const useEventsConnection = (): ConnectionState => useEvents().state

/** Live resource samples for one worktree, newest last. */
export function useResourceSamples(worktreeId: string): ResourceSample[] {
  const { samples } = useEvents()
  useSyncExternalStore(samples.subscribe, samples.getVersion, samples.getVersion)
  return samples.samplesOf(worktreeId)
}

export function useHostSamples(): HostSample[] {
  const { samples } = useEvents()
  useSyncExternalStore(samples.subscribe, samples.getVersion, samples.getVersion)
  return samples.hostSamples()
}

/** Lets the Resources tab merge a GET backfill into the live store. */
export function useSampleStore(): SampleStore {
  return useEvents().samples
}
