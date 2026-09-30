// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DestroyJob } from '@canopy/shared'

import { BackgroundJobs } from '../src/components/background-jobs'
import { destroyJobTitle, heldWorktrees, shownDestroyJobs, upsertDestroyJob } from '../src/lib/destroy-jobs'
import { keys } from '../src/lib/query-keys'
import { ApiProvider } from '../src/providers/api'

const job = (patch: Partial<DestroyJob> = {}): DestroyJob => ({
  id: 'job-1',
  total: 3,
  finished: 0,
  currentId: null,
  currentName: null,
  items: [
    { id: 'a', name: 'alpha' },
    { id: 'b', name: 'beta' },
    { id: 'c', name: 'gamma' }
  ],
  done: [],
  failed: [],
  startedAt: 1,
  finishedAt: null,
  ...patch
})

describe('destroy job model', () => {
  it('says how far a job has got', () => {
    expect(destroyJobTitle(job())).toBe('Waiting to destroy 3 worktrees')
    expect(destroyJobTitle(job({ currentId: 'a', currentName: 'alpha' }))).toBe('Destroying 1 of 3')
    expect(destroyJobTitle(job({ finished: 2, currentId: 'c', currentName: 'gamma', done: ['a', 'b'] }))).toBe('Destroying 3 of 3')
    expect(destroyJobTitle(job({ finished: 3, done: ['a', 'b', 'c'], finishedAt: 9 }))).toBe('Destroyed 3 worktrees')
    expect(destroyJobTitle(job({ finished: 3, done: ['a', 'c'], failed: [{ id: 'b', name: 'beta', message: 'busy' }], finishedAt: 9 }))).toBe('Destroyed 2 of 3 worktrees')
  })

  it('replaces a job by id in the cached list, or adds it', () => {
    const other = job({ id: 'job-0' })
    expect(upsertDestroyJob(undefined, job())).toEqual([job()])
    const moved = job({ finished: 1, done: ['a'] })
    expect(upsertDestroyJob([other, job()], moved)).toEqual([other, moved])
  })

  it('holds the worktrees a running job has not finished with', () => {
    const running = job({ finished: 1, done: ['a'], currentId: 'b', currentName: 'beta' })
    expect([...heldWorktrees([running])]).toEqual([
      ['b', 'destroying'],
      ['c', 'queued']
    ])
    expect(heldWorktrees([job({ finishedAt: 5 })]).size).toBe(0)
  })

  it('skips a clean finish nobody saw running, but keeps one with failures', () => {
    const clean = job({ id: 'clean', finished: 3, finishedAt: 5 })
    const failed = job({ id: 'failed', finished: 3, finishedAt: 5, failed: [{ id: 'b', name: 'beta', message: 'busy' }] })
    const running = job({ id: 'running' })
    expect(shownDestroyJobs([clean, failed, running], new Set(), new Set()).map((j) => j.id)).toEqual(['failed', 'running'])
    expect(shownDestroyJobs([clean], new Set(), new Set(['clean'])).map((j) => j.id)).toEqual(['clean'])
    expect(shownDestroyJobs([failed], new Set(['failed']), new Set())).toEqual([])
  })
})

describe('BackgroundJobs', () => {
  let host: HTMLDivElement
  let root: Root
  let client: QueryClient

  beforeEach(() => {
    vi.useFakeTimers()
    // The first read of the list; the test drives everything after it through the cache.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ jobs: [] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    )
    client = new QueryClient()
    client.setQueryData(keys.destroyJobs, [job({ currentId: 'a', currentName: 'alpha' })])
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() =>
      root.render(
        <ApiProvider connection={{ url: 'http://127.0.0.1:9483', token: 't' }}>
          <QueryClientProvider client={client}>
            <BackgroundJobs />
          </QueryClientProvider>
        </ApiProvider>
      )
    )
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /** react-query tells its observers on a zero-delay timer, which the fake clock holds back. */
  const setJobs = (jobs: DestroyJob[]): void => {
    act(() => {
      client.setQueryData(keys.destroyJobs, jobs)
      vi.advanceTimersByTime(0)
    })
  }
  const fill = (): string | undefined => (host.querySelector('[data-slot="meter-fill"]') as HTMLElement | null)?.style.width

  it('shows a running job, then a clean finish goes away by itself', () => {
    expect(host.textContent).toContain('Destroying 1 of 3')
    expect(host.textContent).toContain('alpha')
    expect(fill()).toBe('0%')

    setJobs([job({ finished: 3, done: ['a', 'b', 'c'], finishedAt: 9 })])
    expect(host.textContent).toContain('Destroyed 3 worktrees')
    expect(fill()).toBe('100%')
    act(() => void vi.advanceTimersByTime(4100))
    expect(host.textContent).toBe('')
  })

  it('keeps a finish with failures until it is dismissed', () => {
    setJobs([job({ finished: 3, done: ['a', 'c'], failed: [{ id: 'b', name: 'beta', message: 'it is busy' }], finishedAt: 9 })])
    act(() => void vi.advanceTimersByTime(10_000))
    expect(host.textContent).toContain('Destroyed 2 of 3 worktrees')
    expect(host.textContent).toContain('beta: it is busy')
    act(() => (host.querySelector('button[aria-label="Dismiss"]') as HTMLButtonElement).click())
    expect(host.textContent).toBe('')
  })
})
