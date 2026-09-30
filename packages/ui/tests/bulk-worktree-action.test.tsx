// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useBulkWorktreeAction, type BulkWorktreeAction, type BulkWorktreeResult } from '../src/lib/api-hooks'
import { ApiProvider } from '../src/providers/api'

describe('useBulkWorktreeAction', () => {
  let host: HTMLDivElement
  let root: Root
  let calls: string[]
  let run: ((ids: string[], action: BulkWorktreeAction) => Promise<BulkWorktreeResult>) | undefined

  beforeEach(() => {
    calls = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`)
        // The second worktree refuses; the run must carry on past it.
        if (url.pathname.endsWith('/wt-2/stop')) return new Response(JSON.stringify({ error: { code: 'busy', message: 'it is busy' } }), { status: 409 })
        return new Response(JSON.stringify({ environment: null }), { status: 200, headers: { 'content-type': 'application/json' } })
      })
    )
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    function Probe(): null {
      const bulk = useBulkWorktreeAction()
      run = (ids, action) => bulk.mutateAsync({ ids, action })
      return null
    }
    act(() =>
      root.render(
        <ApiProvider connection={{ url: 'http://127.0.0.1:9483', token: 't' }}>
          <QueryClientProvider client={new QueryClient()}>
            <Probe />
          </QueryClientProvider>
        </ApiProvider>
      )
    )
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  })

  it('stops one at a time, and reports what failed without stopping the rest', async () => {
    const result = await run!(['wt-1', 'wt-2', 'wt-3'], 'stop')
    expect(calls.filter((call) => call.startsWith('POST'))).toEqual(['POST /api/v1/worktrees/wt-1/stop', 'POST /api/v1/worktrees/wt-2/stop', 'POST /api/v1/worktrees/wt-3/stop'])
    expect(result.done).toEqual(['wt-1', 'wt-3'])
    expect(result.failed.map((failure) => failure.id)).toEqual(['wt-2'])
  })
})
