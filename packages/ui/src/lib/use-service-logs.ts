/**
 * Live log tail for one service: REST backfill (last `limit` lines), then an SSE follow from
 * the returned offset. Reconnects on drop and resumes from the last offset; a `reset` frame
 * (log cleared/rotated) empties the buffer. Lines are capped client-side.
 */
import { useEffect, useRef, useState } from 'react'

import type { LogLine } from '@canopy/shared'

import { useApi } from '../providers/api'

const MAX_LINES = 2000
const BACKFILL = 400

export interface ServiceLogs {
  lines: LogLine[]
  /** Lines existed before the backfill window. */
  truncated: boolean
  state: 'loading' | 'live' | 'reconnecting' | 'ended'
  error: string | null
  clear(): void
}

export function useServiceLogs(worktreeId: string, service: string | undefined): ServiceLogs {
  const api = useApi()
  const [lines, setLines] = useState<LogLine[]>([])
  const [truncated, setTruncated] = useState(false)
  const [state, setState] = useState<ServiceLogs['state']>('loading')
  const [error, setError] = useState<string | null>(null)
  const offset = useRef<number | undefined>(undefined)

  useEffect(() => {
    setLines([])
    setTruncated(false)
    setState('loading')
    setError(null)
    offset.current = undefined
    if (!service) return

    const controller = new AbortController()
    let stopped = false
    const push = (incoming: LogLine[]): void => {
      if (incoming.length === 0) return
      setLines((current) => {
        const next = [...current, ...incoming]
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
      })
    }

    const run = async (): Promise<void> => {
      try {
        const backfill = await api.serviceLogs(worktreeId, service, undefined, BACKFILL)
        if (stopped) return
        push(backfill.lines)
        setTruncated(backfill.truncated)
        offset.current = backfill.nextOffset
      } catch (err) {
        if (stopped) return
        setError(err instanceof Error ? err.message : String(err))
      }
      let attempt = 0
      while (!stopped) {
        try {
          setState('live')
          for await (const event of api.followServiceLogs(worktreeId, service, offset.current, controller.signal)) {
            attempt = 0
            if (event.type === 'line') {
              offset.current = event.line.offset + 1
              push([event.line])
            } else if (event.type === 'reset') {
              offset.current = event.nextOffset
              setLines([])
              setTruncated(false)
            } else if (event.type === 'end') {
              setState('ended')
              return
            }
          }
        } catch {
          // reconnect below
        }
        if (stopped) return
        setState('reconnecting')
        attempt += 1
        await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 500 * 2 ** Math.min(attempt, 4))))
      }
    }
    void run()

    return () => {
      stopped = true
      controller.abort()
    }
  }, [api, worktreeId, service])

  return { lines, truncated, state, error, clear: () => setLines([]) }
}
