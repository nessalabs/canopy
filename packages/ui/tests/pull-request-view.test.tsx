// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PullRequest, PullRequestResponse, Worktree } from '@canopy/shared'

import { PullRequestView } from '../src/components/git/pull-request-view'
import { TooltipProvider } from '../src/components/ui/tooltip'
import { ApiProvider } from '../src/providers/api'

const HEAD = 'b'.repeat(40)
const BASE = 'a'.repeat(40)

const pr: PullRequest = {
  number: 404,
  title: 'Keep a regenerated case off covered rules',
  body: 'Fixes **it**.',
  url: 'https://github.com/acme/app/pull/404',
  state: 'OPEN',
  draft: false,
  author: 'igaurab',
  baseBranch: 'develop',
  headBranch: 'bugfix/regenerate',
  createdAt: '2026-09-28T00:00:00Z',
  updatedAt: '2026-09-29T00:00:00Z',
  mergedAt: null,
  closedAt: null,
  additions: 309,
  deletions: 96,
  changedFiles: 1,
  commits: 2,
  commitLog: [
    { sha: BASE.replace(/a/g, 'c'), shortSha: 'ccccccc', author: 'igaurab', email: 'i@x', at: 1, subject: 'First change', parents: [] },
    { sha: HEAD, shortSha: 'bbbbbbb', author: 'igaurab', email: 'i@x', at: 2, subject: 'Second change', parents: [] }
  ],
  missingCommits: [],
  assignees: [{ login: 'sanzog03', name: 'Sanjog Thapa' }],
  reviewers: [
    { name: 'paridhi-parajuli', team: false, state: 'requested' },
    { name: 'boss', team: false, state: 'APPROVED' }
  ],
  labels: [{ name: 'bug', color: 'd73a4a' }],
  milestone: null,
  reviewDecision: 'REVIEW_REQUIRED',
  mergeable: 'MERGEABLE',
  mergeState: 'BLOCKED',
  autoMerge: false,
  headSha: HEAD,
  filesRange: { before: BASE, after: HEAD },
  checks: [{ name: 'test', workflow: 'CI', outcome: 'fail', url: 'https://github.com/acme/app/actions/runs/1/job/2' }],
  events: [{ kind: 'comment', author: 'pal', body: 'Looks right', verdict: null, at: '2026-09-28T01:00:00Z' }]
}

const response = (over: Partial<PullRequestResponse> = {}): PullRequestResponse => ({
  gh: { state: 'ready', host: 'github.com', repo: 'acme/app', remoteUrl: 'git@github.com:acme/app.git', detail: null },
  branch: 'bugfix/regenerate',
  baseBranch: 'develop-dev',
  upstream: { name: 'origin/bugfix/regenerate', ahead: 1, behind: 0 },
  pr,
  draft: null,
  bases: [],
  suggestedBase: null,
  viewer: 'igaurab',
  mergeMethods: ['squash', 'rebase'],
  canMerge: true,
  ...over
})

const file = (path: string) => ({ path, status: 'M', additions: 1, deletions: 0, binary: false, staged: 'unstaged', conflicted: false, headSha: null, indexSha: null })

const worktree = { id: 'wt-1', branch: 'bugfix/regenerate', baseBranch: 'develop-dev', status: { ahead: 2, dirtyTotal: 1 } } as unknown as Worktree

describe('PullRequestView', () => {
  let host: HTMLDivElement
  let root: Root
  let answer: PullRequestResponse

  beforeEach(() => {
    answer = response()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined }))
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = new URL(input)
        const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
        if (url.pathname.endsWith('/pull-request')) return json(answer)
        if (url.pathname.endsWith('/changes')) return json({ against: 'head', rev: HEAD, baseBranch: 'develop', files: [file('api/local.py')], branch: null, operation: null })
        if (url.pathname.includes('/trees/')) return json({ before: BASE, after: HEAD, files: [file('api/auth.py')] })
        if (url.pathname.includes('/commits/')) return json({ commit: pr.commitLog[1], files: [file('api/roles.py')] })
        if (url.pathname.endsWith('/comments')) return json({ comments: [] })
        return new Response('{}', { status: 404 })
      })
    )
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

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  }

  const render = async (): Promise<void> => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const review = { comments: [], mode: 'unified' as const, onModeChange: () => undefined, onSendForReview: () => undefined, sending: false }
    act(() =>
      root.render(
        <ApiProvider connection={{ url: 'http://127.0.0.1:9483', token: 't' }}>
          <QueryClientProvider client={client}>
            <TooltipProvider>
              <PullRequestView worktree={worktree} review={review} onOpenChanges={() => undefined} />
            </TooltipProvider>
          </QueryClientProvider>
        </ApiProvider>
      )
    )
    await settle()
  }

  const click = async (text: string): Promise<void> => {
    const target = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes(text))
    if (!target) throw new Error(`no button "${text}" in: ${host.textContent}`)
    await act(async () => target.click())
    await settle()
  }

  it('shows the PR, its people, CI, local work and actions', async () => {
    await render()
    const text = host.textContent ?? ''
    expect(text).toContain('Keep a regenerated case off covered rules')
    expect(text).toContain('paridhi-parajuli')
    expect(text).toContain('sanzog03')
    expect(text).toContain('bug')
    expect(text).toContain('1 check failing')
    expect(text).toContain('Re-run failed')
    expect(text).toContain('Blocked')
    expect(text).toContain('1 uncommitted change')
    expect(text).toContain('api/local.py')
    expect(text).toContain('Commit all and push')
    expect(text).toContain('1 local commit not on GitHub yet')
    expect(text).toContain('Looks right')
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Merge')).toBe(true)
  })

  it('puts the checks card after the conversation, and offers a picker for each sidebar section', async () => {
    await render()
    const text = host.textContent ?? ''
    expect(text.indexOf('Looks right')).toBeLessThan(text.indexOf('Re-run failed'))
    const pickers = [...host.querySelectorAll('button[aria-label^="Edit "]')].map((button) => button.getAttribute('aria-label'))
    expect(pickers).toEqual(['Edit reviewers', 'Edit assignees', 'Edit labels', 'Edit milestone'])
  })

  it('lists the PR commits with the chosen one diffed, and its whole diff under Files', async () => {
    await render()
    await click('Commits · 2')
    expect(host.textContent).toContain('Second change')
    expect(host.textContent).toContain('First change')
    expect(host.textContent).toContain('roles.py')

    await click('Files · ')
    expect(host.textContent).toContain('auth.py')
  })

  it('opens the create form on the suggested target when there is no PR', async () => {
    answer = response({ pr: null, draft: { title: 'Evals', body: '' }, bases: ['develop', 'main'], suggestedBase: 'develop' })
    await render()
    expect(host.textContent).toContain('Open a pull request')
    const picker = host.querySelector('button[aria-label="Branch to merge into"]')
    expect(picker?.textContent).toContain('develop')
  })
})
