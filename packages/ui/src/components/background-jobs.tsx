import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'

import type { DestroyJob } from '@canopy/shared'

import { Meter } from '@/components/ui/meter'
import { useDestroyJobs } from '@/lib/api-hooks'
import { destroyJobTitle, shownDestroyJobs } from '@/lib/destroy-jobs'

/** How long a job that finished cleanly stays on screen. */
const CLEAN_FINISH_MS = 4000

/**
 * Work the daemon is doing in the background, in the bottom-right corner of every screen: one
 * small card per destroy job. A job that finished cleanly goes away by itself; one with
 * failures stays until dismissed, so the failures are read. Dismissing is this viewer's own
 * choice and is not sent anywhere.
 */
export function BackgroundJobs(): React.JSX.Element | null {
  const jobs = useDestroyJobs().data
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  // Adding an id is idempotent, so doing it while rendering is safe to repeat.
  const seenRunning = useRef(new Set<string>())
  for (const job of jobs ?? []) if (job.finishedAt === null) seenRunning.current.add(job.id)
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const dismiss = (id: string): void => setDismissed((current) => new Set(current).add(id))

  useEffect(() => {
    for (const job of jobs ?? []) {
      if (job.finishedAt === null || job.failed.length > 0 || timers.current.has(job.id)) continue
      timers.current.set(job.id, setTimeout(() => dismiss(job.id), CLEAN_FINISH_MS))
    }
  }, [jobs])
  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending.values()) clearTimeout(timer)
    }
  }, [])

  const shown = shownDestroyJobs(jobs, dismissed, seenRunning.current)
  if (shown.length === 0) return null
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed right-3 bottom-3 z-40 flex w-72 flex-col gap-2">
      {shown.map((job) => (
        <DestroyJobCard key={job.id} job={job} onDismiss={() => dismiss(job.id)} />
      ))}
    </div>
  )
}

function DestroyJobCard({ job, onDismiss }: { job: DestroyJob; onDismiss: () => void }): React.JSX.Element {
  const finished = job.finishedAt !== null
  return (
    <div className="pointer-events-auto flex flex-col gap-1.5 rounded-lg border border-border bg-popover px-3 py-2 text-popover-foreground shadow-lg">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{destroyJobTitle(job)}</span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {job.finished}/{job.total}
        </span>
        {finished ? (
          <button type="button" aria-label="Dismiss" className="-mr-1 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={onDismiss}>
            <X className="size-3.5" />
          </button>
        ) : null}
      </div>
      <Meter variant="solid" fraction={job.total === 0 ? 1 : job.finished / job.total} />
      {job.currentName ? <span className="truncate font-mono text-[11px] text-muted-foreground">{job.currentName}</span> : null}
      {finished && job.failed.length > 0 ? (
        <ul className="flex max-h-32 flex-col gap-0.5 overflow-y-auto font-mono text-[11px] text-destructive">
          {job.failed.map((failure) => (
            <li key={failure.id} className="break-words">
              {failure.name}: {failure.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
