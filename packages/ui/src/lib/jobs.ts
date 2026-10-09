/**
 * Requests that take seconds and must outlive the component that started them — Claude's drafts,
 * a change's grouping. The user is free to switch tabs or worktrees meanwhile: the request keeps
 * running, and whichever view for that key is mounted when it lands, now or on a later visit,
 * takes the result.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'

export type Job<T> = { status: 'running' } | { status: 'done'; result: T } | { status: 'error'; error: unknown }

export interface JobStore<T> {
  /** Starts `run` unless a job under the same key is already running. */
  start: (key: string, run: () => Promise<T>) => void
  /** Hands a finished result over and forgets it, so it is used exactly once. */
  take: (key: string) => T | undefined
  dismiss: (key: string) => void
  get: (key: string) => Job<T> | undefined
  subscribe: (listener: () => void) => () => void
}

export function createJobStore<T>(): JobStore<T> {
  const jobs = new Map<string, Job<T>>()
  const listeners = new Set<() => void>()
  const set = (key: string, job: Job<T> | undefined): void => {
    if (job) jobs.set(key, job)
    else jobs.delete(key)
    for (const listener of listeners) listener()
  }
  return {
    start(key, run) {
      if (jobs.get(key)?.status === 'running') return
      set(key, { status: 'running' })
      run().then(
        (result) => set(key, { status: 'done', result }),
        (error: unknown) => set(key, { status: 'error', error })
      )
    },
    take(key) {
      const job = jobs.get(key)
      if (job?.status !== 'done') return undefined
      set(key, undefined)
      return job.result
    },
    dismiss: (key) => set(key, undefined),
    get: (key) => jobs.get(key),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

/** One key's job: `onResult` gets a landed result once, even one that finished while nothing here was mounted. */
export function useJob<T>(store: JobStore<T>, key: string, onResult: (result: T) => void) {
  const job = useSyncExternalStore(store.subscribe, () => store.get(key))
  const apply = useRef(onResult)
  apply.current = onResult
  useEffect(() => {
    const result = job?.status === 'done' ? store.take(key) : undefined
    if (result !== undefined) apply.current(result)
  }, [job, store, key])
  return { running: job?.status === 'running', error: job?.status === 'error' ? job.error : undefined, dismiss: () => store.dismiss(key) }
}
