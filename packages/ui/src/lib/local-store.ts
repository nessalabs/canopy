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
