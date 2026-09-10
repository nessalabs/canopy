import { useCallback, useEffect, useRef } from 'react'

/** How long the pointer must rest on a row before its file is read: a sweep across the tree reads nothing. */
const DWELL_MS = 120

/**
 * Turns a stream of hovered paths into one `prefetch` per file the pointer settles on. Moving
 * on before the dwell is up cancels the read; the same path again is not re-armed.
 */
export function useHoverPrefetch(prefetch: (path: string) => void): (path: string) => void {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const armed = useRef<string>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return useCallback(
    (path: string) => {
      if (path === armed.current) return
      clearTimeout(timer.current)
      armed.current = path
      timer.current = setTimeout(() => prefetch(path), DWELL_MS)
    },
    [prefetch]
  )
}
