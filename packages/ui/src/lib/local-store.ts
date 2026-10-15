import { useCallback, useState } from 'react'

/**
 * Best-effort JSON in `localStorage`, for panel state that should survive a toggle or a reload
 * but is never worth an error of its own: a browser with storage turned off, a quota that is
 * full, or a value written by an older shape all simply mean "no stored state".
 */
export function readStored<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? undefined : (JSON.parse(raw) as T)
  } catch {
    return undefined
  }
}

export function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // best-effort persistence only
  }
}

/**
 * `useState` that comes back after a reload: read once from storage, written on every change.
 * A stored value `accept` refuses (an old shape, a view that no longer exists) falls back.
 */
export function useStoredState<T>(key: string, fallback: T, accept: (value: unknown) => value is T = (value): value is T => value !== undefined): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const stored = readStored<unknown>(key)
    return accept(stored) ? stored : fallback
  })
  const set = useCallback(
    (next: T) => {
      setValue(next)
      writeStored(key, next)
    },
    [key]
  )
  return [value, set]
}

/** An `accept` for `useStoredState` that takes one of a fixed set of strings. */
export const oneOf =
  <T extends string>(...options: T[]) =>
  (value: unknown): value is T =>
    typeof value === 'string' && (options as string[]).includes(value)
