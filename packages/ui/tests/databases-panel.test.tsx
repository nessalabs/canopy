// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DbInstanceInfo, Worktree } from '@canopy/shared'

import { DatabasesPanel } from '../src/components/environment/databases-panel'
import { TooltipProvider } from '../src/components/ui/tooltip'
import { ApiProvider } from '../src/providers/api'

const database: DbInstanceInfo = {
  name: 'main',
  adapter: 'postgres',
  status: 'ready',
  connectionUrl: 'postgresql://canopy:canopy@127.0.0.1:54316/wt_abc_main',
  envKey: 'DATABASE_URL',
  forkedFrom: 'worktree billing',
  forkedFromDatabase: 'wt_billing_main',
  forkedFromBranch: 'feature/billing',
  sizeMb: 7.25,
  seededAt: Date.now(),
  detail: { container: 'canopy-pg-16', database: 'wt_abc_main', port: '54316' },
  error: null
}

const worktree = (databases: DbInstanceInfo[]): Worktree =>
  ({
    id: 'wt-1',
    projectId: 'p-1',
    name: 'feat-synthesizer',
    path: '/tmp/wt',
    branch: 'feature/synthesizer',
    baseBranch: 'main',
    isMain: false,
    managed: true,
    state: 'dirty',
    status: null,
    environment: {
      state: 'running',
      stateReason: null,
      desired: 'running',
      configured: true,
      configErrors: [],
      services: [],
      databases,
      ports: {},
      env: [],
      provisioning: null,
      provisionedAt: null,
      copiedFiles: [],
      caches: [],
      envFile: null,
      startedAt: null,
      options: { services: null, env: [], dbSource: 'template', caches: {}, cacheSource: 'primary', skipSetup: false, runtime: null }
    }
  }) as Worktree

describe('DatabasesPanel', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const render = (databases: DbInstanceInfo[]): void => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    act(() =>
      root.render(
        <ApiProvider connection={{ url: 'http://127.0.0.1:9483', token: 't' }}>
          <QueryClientProvider client={client}>
            <TooltipProvider>
              <DatabasesPanel worktree={worktree(databases)} />
            </TooltipProvider>
          </QueryClientProvider>
        </ApiProvider>
      )
    )
  }

  it('shows a fork with the database and branch it came from', () => {
    render([database])
    expect(host.textContent).toContain('wt_billing_main')
    expect(host.textContent).toContain('feature/billing')
  })

  /**
   * A daemon whose lineage migration never ran omits the two `forkedFrom*` fields, which used
   * to throw here and — with no boundary above it — left the whole window blank.
   */
  it('renders a row from a daemon that sent no lineage', () => {
    const legacy = { ...database }
    delete (legacy as { forkedFromDatabase?: string | null }).forkedFromDatabase
    delete (legacy as { forkedFromBranch?: string | null }).forkedFromBranch

    render([legacy])

    expect(host.textContent).toContain('lineage not recorded')
    expect(host.textContent).toContain('wt_abc_main')
  })
})
