import { useCallback, useState } from 'react'

/** One file a pane has shown, and the heading the link that opened it named. */
export interface FileStop {
  path: string
  hash?: string
}

/**
 * Where a file pane is, and how it got there: picking a file starts a fresh trail, following a
 * link inside a rendered doc pushes a stop, Back pops one. `base` is the file the pane falls
 * back to before anything is picked — a link followed from it seeds the trail so Back returns.
 */
export function useFileTrail(base?: string) {
  const [trail, setTrail] = useState<FileStop[]>([])
  const current: FileStop | undefined = trail.at(-1) ?? (base === undefined ? undefined : { path: base })
  return {
    current,
    /** Show a file — at a heading or line (`L42`) when `hash` names one — dropping wherever the trail had reached. */
    go: useCallback((path: string, hash?: string) => setTrail([{ path, hash }]), []),
    /** Forget the trail; the pane falls back to `base`. */
    reset: useCallback(() => setTrail([]), []),
    /** Follow a link out of the current file, keeping it as the way back. */
    open: useCallback(
      (path: string, hash?: string) => setTrail((stops) => [...(stops.length > 0 || current === undefined ? stops : [current]), { path, hash }]),
      [current]
    ),
    back: trail.length > 1 ? () => setTrail((stops) => stops.slice(0, -1)) : undefined
  }
}
