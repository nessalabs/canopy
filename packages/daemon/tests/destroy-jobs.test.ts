import { existsSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { routes, type CanopyEvent, type DestroyJob } from '@canopy/shared'

import { createEventBus } from '../src/env/events/bus'
import { ApiError, notFound } from '../src/lib/errors'
import { DestroyJobsService } from '../src/worktrees/destroy-jobs'
import { createFixtureRepo, type FixtureRepo } from './helpers/fixture-repo'
import { createTestServer, type TestServer } from './helpers/test-server'

/** A deferred promise per destroy, so a test decides when each one lands. */
function fakeWorktrees(rows: Record<string, { name: string; main?: boolean }>) {
  const calls: { id: string; force: boolean; deleteBranch: string | undefined }[] = []
  const pending: { id: string; settle: (error?: Error) => void }[] = []
  return {
    calls,
    pending,
    row: (id: string) => {
      const row = rows[id]
      if (!row) throw notFound('worktree', id)
      return { id, name: row.name, is_main: row.main ? 1 : 0 } as never
    },
    destroy: (id: string, force: boolean, deleteBranch?: 'never' | 'if-merged' | 'always') => {
      calls.push({ id, force, deleteBranch })
      return new Promise<{ salvaged: null }>((resolve, reject) => {
        pending.push({ id, settle: (error) => (error ? reject(error) : resolve({ salvaged: null })) })
      })
    }
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Lets the job reach its next destroy, then settles it. */
async function settleNext(worktrees: ReturnType<typeof fakeWorktrees>, error?: Error): Promise<void> {
  for (let i = 0; i < 20 && worktrees.pending.length === 0; i++) await tick()
  const next = worktrees.pending.shift()
  if (!next) throw new Error('no destroy is waiting')
  next.settle(error)
  await tick()
}

describe('DestroyJobsService', () => {
  let events: CanopyEvent[]
  let bus: ReturnType<typeof createEventBus>
  let now: number

  beforeEach(() => {
    events = []
    bus = createEventBus()
    bus.subscribe((event) => events.push(event))
    now = 1_000
  })

  const jobEvents = (): DestroyJob[] => events.flatMap((event) => (event.type === 'destroy-job' ? [event.job] : []))

  it('answers at once, then destroys one at a time in order, carrying on past a failure', async () => {
    const worktrees = fakeWorktrees({ a: { name: 'alpha' }, b: { name: 'beta' }, c: { name: 'gamma' } })
    const jobs = new DestroyJobsService({ worktrees, events: bus, now: () => now })
    const job = jobs.start({
      items: [
        { id: 'a', force: true, deleteBranch: true },
        { id: 'b', force: false, deleteBranch: false },
        { id: 'c', force: false, deleteBranch: false }
      ]
    })
    expect(job).toMatchObject({ total: 3, finished: 0, currentId: null, finishedAt: null, items: [{ id: 'a', name: 'alpha' }, { id: 'b', name: 'beta' }, { id: 'c', name: 'gamma' }] })
    expect(worktrees.calls).toEqual([])

    await settleNext(worktrees)
    // Never two at once: the second destroy waits for the first to land.
    expect(worktrees.calls.map((call) => call.id)).toEqual(['a', 'b'])
    await settleNext(worktrees, new Error('it is busy'))
    now = 5_000
    await settleNext(worktrees)

    expect(worktrees.calls).toEqual([
      { id: 'a', force: true, deleteBranch: 'always' },
      { id: 'b', force: false, deleteBranch: 'never' },
      { id: 'c', force: false, deleteBranch: 'never' }
    ])
    const [finished] = jobs.list()
    expect(finished).toMatchObject({ finished: 3, done: ['a', 'c'], failed: [{ id: 'b', name: 'beta', message: 'it is busy' }], currentId: null, finishedAt: 5_000 })

    // Queued, then each item started and finished, then the end.
    const seen = jobEvents()
    expect(seen.map((j) => [j.finished, j.currentName])).toEqual([
      [0, null],
      [0, 'alpha'],
      [1, 'alpha'],
      [1, 'beta'],
      [2, 'beta'],
      [2, 'gamma'],
      [3, 'gamma'],
      [3, null]
    ])
    // Every event is a snapshot: later progress does not rewrite what was already sent.
    expect(seen[0]!.done).toEqual([])
  })

  it('refuses the main checkout, an unknown worktree, or one a running job holds, before destroying anything', async () => {
    const worktrees = fakeWorktrees({ main: { name: 'main', main: true }, a: { name: 'alpha' }, b: { name: 'beta' } })
    const jobs = new DestroyJobsService({ worktrees, events: bus })
    const refusal = (fn: () => unknown) => {
      try {
        fn()
      } catch (error) {
        return error instanceof ApiError ? `${error.status} ${error.code}` : String(error)
      }
      return 'accepted'
    }

    expect(refusal(() => jobs.start({ items: [{ id: 'a', force: false, deleteBranch: false }, { id: 'main', force: false, deleteBranch: false }] }))).toBe('409 cannot_destroy_main')
    expect(refusal(() => jobs.start({ items: [{ id: 'a', force: false, deleteBranch: false }, { id: 'nope', force: false, deleteBranch: false }] }))).toBe('404 worktree_not_found')
    expect(jobs.list()).toEqual([])

    jobs.start({ items: [{ id: 'a', force: false, deleteBranch: false }] })
    expect(refusal(() => jobs.start({ items: [{ id: 'b', force: false, deleteBranch: false }, { id: 'a', force: false, deleteBranch: false }] }))).toBe('409 destroy_in_progress')
    // Another worktree is fine, and waits its turn behind the first job.
    jobs.start({ items: [{ id: 'b', force: false, deleteBranch: false }] })
    await tick()
    expect(worktrees.calls.map((call) => call.id)).toEqual(['a'])
    await settleNext(worktrees)
    await settleNext(worktrees)
    expect(worktrees.calls.map((call) => call.id)).toEqual(['a', 'b'])
    expect(jobs.list().map((job) => job.finishedAt !== null)).toEqual([true, true])
  })

  it('lists a finished job for a while, then forgets it', async () => {
    const worktrees = fakeWorktrees({ a: { name: 'alpha' } })
    const jobs = new DestroyJobsService({ worktrees, events: bus, now: () => now, keepFinishedMs: 60_000 })
    jobs.start({ items: [{ id: 'a', force: false, deleteBranch: false }] })
    await settleNext(worktrees)
    expect(jobs.list()).toHaveLength(1)
    now += 59_000
    expect(jobs.list()).toHaveLength(1)
    now += 2_000
    expect(jobs.list()).toEqual([])
  })
})

describe('destroy job routes', () => {
  let server: TestServer
  let repo: FixtureRepo
  let projectId: string

  beforeEach(async () => {
    server = await createTestServer()
    repo = await createFixtureRepo()
    await repo.commit({ 'a.txt': 'one\n' }, 'init')
    projectId = (await server.call('POST', routes.projects(), { path: repo.path })).body.project.id
  })
  afterEach(async () => {
    await server.close()
    repo.cleanup()
  })

  async function created(name: string) {
    const id = (await server.call('POST', routes.projectWorktrees(projectId), { name, branch: { mode: 'new', name: `feat/${name}`, base: 'main' } })).body.worktree.id
    for (let i = 0; i < 200; i++) {
      const { body } = await server.call('GET', routes.worktree(id))
      if (body.worktree.environment.state !== 'creating' && body.worktree.environment.state !== 'provisioning') return body.worktree
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('worktree never left creating')
  }

  it('queues a job with 202, destroys every worktree in it, and lists how it ended', async () => {
    const one = await created('one')
    const two = await created('two')
    const started = await server.call('POST', routes.destroyJobs(), {
      items: [
        { id: one.id, force: false, deleteBranch: true },
        { id: two.id, force: false, deleteBranch: false }
      ]
    })
    expect(started.status).toBe(202)
    expect(started.body.job).toMatchObject({ total: 2, items: [{ name: 'one' }, { name: 'two' }] })

    let job: DestroyJob | undefined
    for (let i = 0; i < 200; i++) {
      job = (await server.call('GET', routes.destroyJobs())).body.jobs[0]
      if (job?.finishedAt !== null) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(job).toMatchObject({ finished: 2, done: [one.id, two.id], failed: [] })
    expect(existsSync(one.path)).toBe(false)
    expect(existsSync(two.path)).toBe(false)
    const branches = await repo.git('branch', '--list', 'feat/*')
    expect(branches).not.toContain('feat/one')
    expect(branches).toContain('feat/two')
  })

  it('rejects an empty or repeated list, and the main checkout', async () => {
    const one = await created('one')
    expect((await server.call('POST', routes.destroyJobs(), { items: [] })).status).toBe(400)
    const twice = { id: one.id, force: false, deleteBranch: false }
    expect((await server.call('POST', routes.destroyJobs(), { items: [twice, twice] })).status).toBe(400)
    const main = (await server.call('GET', routes.worktrees())).body.worktrees.find((wt: { isMain: boolean }) => wt.isMain)
    const refused = await server.call('POST', routes.destroyJobs(), { items: [{ id: main.id, force: false, deleteBranch: false }] })
    expect(refused.status).toBe(409)
    expect(refused.body.error.code).toBe('cannot_destroy_main')
  })
})
