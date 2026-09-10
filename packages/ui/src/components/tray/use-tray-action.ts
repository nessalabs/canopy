import { useCallback, useEffect, useRef, useState } from 'react'

export interface TrayActionRunner {
  /** Runs one action, keeping `pending` true until it settles and surfacing its message. */
  run: (label: string, action: () => Promise<string | null>) => void
  /** The label passed to `run`, while it is in flight. */
  pending: string | null
  error: string | null
  dismiss: () => void
}

/**
 * One action at a time per row. The panel is a transient window with no room for toasts, so a
 * failure stays on the row that caused it until the next action replaces it.
 */
export function useTrayAction(): TrayActionRunner {
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const live = useRef(true)
  useEffect(
    () => () => {
      live.current = false
    },
    []
  )

  const run = useCallback((label: string, action: () => Promise<string | null>) => {
    setPending(label)
    setError(null)
    void action()
      .then((failure) => {
        if (live.current) setError(failure)
      })
      .catch((failure: unknown) => {
        if (live.current) setError(failure instanceof Error ? failure.message : String(failure))
      })
      .finally(() => {
        if (live.current) setPending(null)
      })
  }, [])

  const dismiss = useCallback(() => setError(null), [])

  return { run, pending, error, dismiss }
}
