/**
 * Opening one thing in a window of its own. The second window is this same app on a
 * `/window/…` hash route, so nothing can be handed to it as a prop: a file travels in the
 * route, and a diagram — whose source is arbitrarily long and belongs to no path of its own —
 * is stashed in storage under a key the route carries.
 */

const DIAGRAM_PREFIX = 'canopy:diagram:'
/** How long a stashed diagram stays readable: long enough that reloading its window still works. */
const DIAGRAM_TTL = 24 * 60 * 60 * 1000

/** The rev segment for a file read from the working tree rather than a commit. */
const WORKING_TREE = '-'

/** Where the window showing one file opens. Slashes stay slashes; the screen decodes the rest. */
export const fileWindowHash = (worktreeId: string, path: string, rev?: string): string =>
  `/window/file/${encodeURIComponent(worktreeId)}/${encodeURIComponent(rev ?? WORKING_TREE)}/${encodeURI(path)}`

/** Reads back what `fileWindowHash` wrote, tolerating a path that never needed encoding. */
export function fileWindowParams(worktreeId: string, rev: string, path: string): { worktreeId: string; rev?: string; path: string } {
  const decode = (value: string): string => {
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  return { worktreeId: decode(worktreeId), rev: rev === WORKING_TREE ? undefined : decode(rev), path: decode(path) }
}

export const diagramWindowHash = (key: string): string => `/window/diagram/${encodeURIComponent(key)}`

interface StashedDiagram {
  chart: string
  at: number
}

/** Drops diagrams older than the TTL, so a long session cannot fill the origin's storage. */
function pruneDiagrams(): void {
  const stale = Object.keys(localStorage).filter((key) => {
    if (!key.startsWith(DIAGRAM_PREFIX)) return false
    try {
      const entry = JSON.parse(localStorage.getItem(key) ?? '') as StashedDiagram
      return Date.now() - entry.at > DIAGRAM_TTL
    } catch {
      return true
    }
  })
  for (const key of stale) localStorage.removeItem(key)
}

/** Puts one diagram where the window about to open can read it; returns the key for its route. */
export function stashDiagram(chart: string): string {
  const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  try {
    pruneDiagrams()
    localStorage.setItem(DIAGRAM_PREFIX + key, JSON.stringify({ chart, at: Date.now() } satisfies StashedDiagram))
  } catch {
    // Storage may be full or unavailable; the window still opens and says it found nothing.
  }
  return key
}

/** The diagram a window was opened on, or null once it has expired or was never stashed. */
export function readDiagram(key: string): string | null {
  try {
    const stored = localStorage.getItem(DIAGRAM_PREFIX + key)
    return stored === null ? null : (JSON.parse(stored) as StashedDiagram).chart
  } catch {
    return null
  }
}
