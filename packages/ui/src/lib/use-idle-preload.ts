import { useEffect } from 'react'

/**
 * Runs `load` once the browser has a quiet moment after this component mounts — for fetching a
 * chunk the screen will probably want, without competing with the paint it is doing now.
 * Falls back to a short timer where idle callbacks are not available.
 */
export function useIdlePreload(load: () => void): void {
  useEffect(() => whenIdle(load), [load])
}

/** Runs `task` at the browser's next quiet moment; returns a cancel. */
export function whenIdle(task: () => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(task, { timeout: 2000 })
    return () => cancelIdleCallback(handle)
  }
  const timer = setTimeout(task, 500)
  return () => clearTimeout(timer)
}
