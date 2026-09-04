import type { DaemonConnection } from '../providers/platform'

const KEY = 'canopy.connection'

/** Web clients remember the last daemon they connected to; desktop reads ~/.canopy instead. */
export const connectionStore = {
  load(): DaemonConnection | null {
    try {
      const raw = localStorage.getItem(KEY)
      return raw ? (JSON.parse(raw) as DaemonConnection) : null
    } catch {
      return null
    }
  },
  save(connection: DaemonConnection): void {
    localStorage.setItem(KEY, JSON.stringify(connection))
  },
  clear(): void {
    localStorage.removeItem(KEY)
  }
}
