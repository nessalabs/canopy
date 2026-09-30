/**
 * Destroying several worktrees as a job the daemon runs on its own. The client asks once, is
 * answered at once with the job, and follows it through `destroy-job` events — so closing the
 * dialog, changing screens or reloading the page loses nothing.
 *
 * Items go one at a time, and jobs one after another across the whole daemon: removals in one
 * repository share git's worktree administration and its locks, and in parallel they would
 * only queue up there or trip over each other. Each item is the same `destroy` the single
 * DELETE route makes, so salvage and branch cleanup behave exactly as they do one by one.
 */
import type { DestroyJob, StartDestroyJobInput } from '@canopy/shared'

import type { EventBus } from '../env/types'
import { conflict } from '../lib/errors'
import { newId } from '../lib/ids'
import type { WorktreesService } from './service'

/** How long a finished job is still listed, so a client that reloads can see how it ended. */
const KEEP_FINISHED_MS = 10 * 60_000

interface Deps {
  worktrees: Pick<WorktreesService, 'row' | 'destroy'>
  events: EventBus
  now?: () => number
  keepFinishedMs?: number
}

type Items = StartDestroyJobInput['items']

export class DestroyJobsService {
  /** Each job as it now stands. Replaced, never mutated: the event bus keeps what it was sent. */
  private readonly jobs = new Map<string, DestroyJob>()
  /** The chain every job's run joins, so only one destroy is ever in flight. */
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly deps: Deps) {}

  /**
   * Checks every worktree before anything is destroyed — one unknown id, the main checkout, or
   * a worktree another job already holds refuses the whole request — then queues the job and
   * answers with it.
   */
  start(input: StartDestroyJobInput): DestroyJob {
    this.prune()
    const held = new Set<string>()
    for (const job of this.jobs.values()) if (job.finishedAt === null) for (const item of job.items) held.add(item.id)
    const items = input.items.map(({ id }) => {
      const row = this.deps.worktrees.row(id)
      if (row.is_main) throw conflict('cannot_destroy_main', 'the primary checkout cannot be destroyed')
      if (held.has(id)) throw conflict('destroy_in_progress', `${row.name} is already being destroyed`)
      return { id, name: row.name }
    })
    const job: DestroyJob = {
      id: newId(),
      total: items.length,
      finished: 0,
      currentId: null,
      currentName: null,
      items,
      done: [],
      failed: [],
      startedAt: this.now(),
      finishedAt: null
    }
    this.update(job)
    // `run` catches each item's failure itself; this catch is for a bug in the bookkeeping,
    // which must not reject unhandled or stall the jobs queued behind this one.
    this.queue = this.queue
      .then(() => this.run(job.id, input.items))
      .catch((error: unknown) => console.error('[destroy-jobs] job failed:', error))
    return job
  }

  /** Running jobs and the ones that finished recently, oldest first. */
  list(): DestroyJob[] {
    this.prune()
    return [...this.jobs.values()]
  }

  private async run(jobId: string, items: Items): Promise<void> {
    for (const item of items) {
      const before = this.get(jobId)
      const name = before.items.find((entry) => entry.id === item.id)?.name ?? item.id
      this.update({ ...before, currentId: item.id, currentName: name })
      let failure: string | null = null
      try {
        await this.deps.worktrees.destroy(item.id, item.force, item.deleteBranch ? 'always' : 'never')
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }
      const after = this.get(jobId)
      this.update({
        ...after,
        finished: after.finished + 1,
        done: failure === null ? [...after.done, item.id] : after.done,
        failed: failure === null ? after.failed : [...after.failed, { id: item.id, name, message: failure }]
      })
    }
    this.update({ ...this.get(jobId), currentId: null, currentName: null, finishedAt: this.now() })
  }

  private get(jobId: string): DestroyJob {
    const job = this.jobs.get(jobId)
    // Running jobs are never pruned, so this is a bug rather than a state to handle.
    if (!job) throw new Error(`destroy job ${jobId} disappeared while running`)
    return job
  }

  private update(job: DestroyJob): void {
    this.jobs.set(job.id, job)
    this.deps.events.emit({ type: 'destroy-job', job })
  }

  private prune(): void {
    const cutoff = this.now() - (this.deps.keepFinishedMs ?? KEEP_FINISHED_MS)
    for (const [id, job] of this.jobs) if (job.finishedAt !== null && job.finishedAt < cutoff) this.jobs.delete(id)
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }
}
