import { useSyncExternalStore } from 'react'

/** What the connected daemon can do for us, learned from its `hello` when the event stream opens. */
export interface DaemonCapabilities {
  /** It watches worktree files and pushes `files-changed`; polling is only a fallback then. */
  watch: boolean
}

let current: DaemonCapabilities = { watch: false }
const listeners = new Set<() => void>()

export function setDaemonCapabilities(next: DaemonCapabilities): void {
  if (next.watch === current.watch) return
  current = next
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const useDaemonCapabilities = (): DaemonCapabilities => useSyncExternalStore(subscribe, () => current, () => current)
