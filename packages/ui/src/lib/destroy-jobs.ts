/**
 * What the UI makes of the daemon's destroy jobs: the cached list the event stream keeps
 * current, the words a job's card says, and which worktrees a running job still holds.
 */
import type { DestroyJob } from '@canopy/shared'

import { plural } from './format'

/** Puts a job's latest state into the cached list, replacing the one with its id or adding it. */
export function upsertDestroyJob(jobs: DestroyJob[] | undefined, job: DestroyJob): DestroyJob[] {
  const list = jobs ?? []
  return list.some((existing) => existing.id === job.id) ? list.map((existing) => (existing.id === job.id ? job : existing)) : [...list, job]
}

export function destroyJobTitle(job: DestroyJob): string {
  if (job.finishedAt !== null) {
    return job.failed.length === 0 ? `Destroyed ${plural(job.total, 'worktree')}` : `Destroyed ${job.done.length} of ${plural(job.total, 'worktree')}`
  }
  // Nothing started yet: another job is still working through its own list.
  if (job.currentId === null && job.finished === 0) return `Waiting to destroy ${plural(job.total, 'worktree')}`
  return `Destroying ${Math.min(job.finished + 1, job.total)} of ${job.total}`
}

export type HeldPhase = 'destroying' | 'queued'

/** Worktrees a running job has not finished with yet: the one it is on, and the ones still to come. */
export function heldWorktrees(jobs: DestroyJob[] | undefined): Map<string, HeldPhase> {
  const held = new Map<string, HeldPhase>()
  for (const job of jobs ?? []) {
    if (job.finishedAt !== null) continue
    const finished = new Set([...job.done, ...job.failed.map((failure) => failure.id)])
    for (const item of job.items) {
      if (finished.has(item.id)) continue
      held.set(item.id, item.id === job.currentId ? 'destroying' : 'queued')
    }
  }
  return held
}

/**
 * The jobs the progress tray shows: every running one, and a finished one until it is
 * dismissed. A job that ended cleanly before this viewer saw it running (a reload after it was
 * done) has nothing left to say and is skipped; one with failures is shown until dismissed.
 */
export function shownDestroyJobs(jobs: DestroyJob[] | undefined, dismissed: ReadonlySet<string>, seenRunning: ReadonlySet<string>): DestroyJob[] {
  return (jobs ?? []).filter((job) => !dismissed.has(job.id) && (job.finishedAt === null || job.failed.length > 0 || seenRunning.has(job.id)))
}
