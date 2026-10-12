import { describe, expect, it } from 'vitest'

import { isAttachmentUrl, type GhStatus } from '@canopy/shared'

import type { GhRun, GhRunner } from '../src/github/gh'
import { openDb } from '../src/db'
import { IssueCache } from '../src/github/issue-cache'
import { IssuesService, toIssueSummary, toTimelineItem } from '../src/github/issues'

const ok = (stdout = ''): GhRun => ({ found: true, exitCode: 0, stdout, stderr: '' })
const READY: GhStatus = { state: 'ready', host: 'github.com', repo: 'acme/app', remoteUrl: 'git@github.com:acme/app.git', detail: null }

function fakeGh(answer: (args: string[]) => GhRun): GhRunner & { calls: string[][] } {
  const calls: string[][] = []
  const run = (async (_cwd: string, args: string[]) => {
    calls.push(args)
    return answer(args)
  }) as GhRunner & { calls: string[][] }
  run.calls = calls
  return run
}

const RAW_ISSUE = { number: 249, title: 'Move files to S3', state: 'open', html_url: 'https://github.com/acme/app/issues/249', user: { login: 'rohit' }, updated_at: '2026-09-10T00:00:00Z', created_at: '2026-08-13T00:00:00Z', body: 'TBD' }

describe('toIssueSummary', () => {
  it('reads an issue', () => {
    expect(toIssueSummary(RAW_ISSUE)).toMatchObject({ number: 249, kind: 'issue', state: 'OPEN', author: 'rohit' })
  })

  it('reads a merged PR as merged', () => {
    expect(toIssueSummary({ ...RAW_ISSUE, state: 'closed', pull_request: { merged_at: '2026-09-11T00:00:00Z' } })).toMatchObject({ kind: 'pr', state: 'MERGED' })
  })
})

describe('toTimelineItem', () => {
  it('keeps a comment as what was written', () => {
    expect(toTimelineItem({ event: 'commented', id: 1, user: { login: 'sanzog' }, created_at: 't', body: 'update the ticket', html_url: 'u' }, 0)).toEqual({
      type: 'comment',
      id: '1',
      author: 'sanzog',
      createdAt: 't',
      body: 'update the ticket',
      url: 'u'
    })
  })

  it('puts an event into words, with the issue it points at', () => {
    expect(toTimelineItem({ event: 'cross-referenced', actor: { login: 'sanzog' }, created_at: 't', source: { issue: { number: 158 } } }, 3)).toMatchObject({
      type: 'event',
      actor: 'sanzog',
      text: 'mentioned this in #158',
      ref: 158
    })
  })

  it('tells self-assignment apart', () => {
    expect(toTimelineItem({ event: 'assigned', actor: { login: 'rohit' }, assignee: { login: 'rohit' } }, 0)).toMatchObject({ text: 'self-assigned this' })
  })

  it('drops bookkeeping', () => {
    expect(toTimelineItem({ event: 'subscribed' }, 0)).toBeNull()
  })

  it('names an event it has no words for', () => {
    expect(toTimelineItem({ event: 'some_new_event' }, 0)).toMatchObject({ text: 'some new event' })
  })
})

describe('isAttachmentUrl', () => {
  it.each([
    ['https://github.com/user-attachments/files/1/plan.md', true],
    ['https://github.com/acme/app/files/1/plan.md', true],
    ['https://private-user-images.githubusercontent.com/x.png', true],
    ['http://github.com/user-attachments/files/1/plan.md', false],
    ['https://example.com/plan.md', false],
    ['https://github.com/acme/app/issues/1', false]
  ])('%s → %s', (url, expected) => expect(isAttachmentUrl(url)).toBe(expected))
})

/** A service over a fresh in-memory copy, with the clock the test moves. */
function setup(answer: (args: string[]) => GhRun, status: GhStatus = READY) {
  const gh = fakeGh(answer)
  const cache = new IssueCache(openDb(':memory:'))
  const clock = { now: Date.parse('2026-10-12T12:00:00Z') }
  const service = new IssuesService({ gh, status: async () => status, cache, now: () => clock.now })
  return { gh, cache, clock, service }
}

const lines = (...items: object[]): GhRun => ok(items.map((item) => JSON.stringify(item)).join('\n'))
const RAW_PR = { ...RAW_ISSUE, number: 282, title: 'Copy contexts to S3', html_url: 'https://github.com/acme/app/pull/282', pull_request: {} }
const isSync = (args: string[]) => args.some((arg) => arg.startsWith('repos/acme/app/issues?'))

describe('IssuesService', () => {
  it('syncs everything once, then answers searches from the local copy', async () => {
    const { gh, service } = setup((args) => (isSync(args) ? lines(RAW_ISSUE, RAW_PR) : ok()))
    expect((await service.search('/repo', '', { kind: 'issue', state: 'open' })).items.map((i) => i.number)).toEqual([249])
    expect((await service.search('/repo', 's3', { kind: 'pr', state: 'open' })).items.map((i) => i.number)).toEqual([282])
    expect(gh.calls.filter(isSync)).toHaveLength(1)
    expect(gh.calls[0]!.join(' ')).not.toContain('since=')
  })

  it('catches up on what changed since the last sync once the copy is stale, new issues included', async () => {
    let remote = [RAW_ISSUE]
    const { gh, clock, service } = setup((args) => (isSync(args) ? lines(...remote) : ok()))
    await service.search('/repo', '', { kind: 'issue', state: 'open' })
    remote = [{ ...RAW_ISSUE, number: 500, title: 'Opened a minute ago', updated_at: '2026-10-12T12:09:00Z' }]
    clock.now += 10 * 60_000
    const found = await service.search('/repo', '', { kind: 'issue', state: 'open' })
    expect(found.items.map((item) => item.number)).toEqual([500, 249])
    const syncs = gh.calls.filter(isSync)
    expect(syncs).toHaveLength(2)
    expect(syncs[1]!.join(' ')).toContain('since=2026-10-12T11:59:00.000Z')
  })

  it('drops an issue closed on GitHub from the open list at the next catch-up', async () => {
    let remote = [RAW_ISSUE]
    const { clock, service } = setup((args) => (isSync(args) ? lines(...remote) : ok()))
    expect((await service.search('/repo', '', { kind: 'issue', state: 'open' })).items).toHaveLength(1)
    remote = [{ ...RAW_ISSUE, state: 'closed', updated_at: '2026-10-12T12:05:00Z' }]
    clock.now += 10 * 60_000
    expect((await service.search('/repo', '', { kind: 'issue', state: 'open' })).items).toEqual([])
  })

  it('rebuilds the copy when GitHub counts fewer than it holds — something was deleted or moved away', async () => {
    let remote: object[] = [RAW_ISSUE, { ...RAW_ISSUE, number: 300 }]
    const { gh, clock, service } = setup((args) => {
      if (isSync(args)) return lines(...remote)
      if (args.includes('search/issues')) return ok(JSON.stringify({ total_count: remote.length }))
      return ok()
    })
    await service.search('/repo', '', { kind: 'issue', state: 'all' })
    remote = [RAW_ISSUE]
    clock.now += 10 * 60_000
    await service.search('/repo', '', { kind: 'issue', state: 'all' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((await service.search('/repo', '', { kind: 'issue', state: 'all' })).items.map((item) => item.number)).toEqual([249])
    expect(gh.calls.filter(isSync).at(-1)!.join(' ')).not.toContain('since=')
  })

  it('leaves the copy be when the counts agree, and checks again only after a while', async () => {
    const { gh, clock, service } = setup((args) => {
      if (isSync(args)) return lines(RAW_ISSUE)
      return ok(JSON.stringify({ total_count: 1 }))
    })
    await service.search('/repo', '', { kind: 'issue', state: 'all' })
    for (const minutes of [1, 1]) {
      clock.now += minutes * 60_000
      await service.search('/repo', '', { kind: 'issue', state: 'all' })
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(gh.calls.filter((args) => args.includes('search/issues'))).toHaveLength(1)
    expect(gh.calls.filter(isSync).every((args, index) => index === 0 || args.join(' ').includes('since='))).toBe(true)
  })

  it('forgets an issue deleted on GitHub when it is opened', async () => {
    const { cache, service } = setup((args) => (isSync(args) ? lines(RAW_ISSUE) : { found: true, exitCode: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }))
    await service.search('/repo', '', { kind: 'issue', state: 'open' })
    await expect(service.read('/repo', 249)).rejects.toMatchObject({ status: 404 })
    expect(cache.summary('acme/app', 249)).toBeUndefined()
  })

  it('says where an issue was transferred to, and forgets it here', async () => {
    const { cache, service } = setup((args) => {
      if (isSync(args)) return lines(RAW_ISSUE)
      if (args.includes('--paginate')) return lines()
      return ok(JSON.stringify({ ...RAW_ISSUE, number: 12, repository_url: 'https://api.github.com/repos/acme/other' }))
    })
    await service.search('/repo', '', { kind: 'issue', state: 'open' })
    await expect(service.read('/repo', 249)).rejects.toMatchObject({ status: 410, message: '#249 was moved to acme/other#12' })
    expect(cache.summary('acme/app', 249)).toBeUndefined()
  })

  it('filters by assignee, and names everyone assigned and who "me" is', async () => {
    const { service } = setup((args) => {
      if (isSync(args)) return lines({ ...RAW_ISSUE, assignees: [{ login: 'rohit' }] }, { ...RAW_ISSUE, number: 300, assignees: [{ login: 'igaurab' }, { login: 'sanzog' }] })
      return ok(JSON.stringify({ login: 'igaurab' }))
    })
    const mine = await service.search('/repo', '', { kind: 'issue', state: 'open', assignee: 'igaurab' })
    expect(mine.items.map((item) => [item.number, item.assignees])).toEqual([[300, ['igaurab', 'sanzog']]])
    expect(await service.assignees('/repo')).toEqual({ assignees: ['igaurab', 'rohit', 'sanzog'], viewer: 'igaurab' })
  })

  it('does not ask GitHub again while the copy is fresh', async () => {
    const { gh, clock, service } = setup((args) => (isSync(args) ? lines(RAW_ISSUE) : ok()))
    await service.search('/repo', '', { kind: 'issue', state: 'open' })
    clock.now += 20_000
    await service.search('/repo', 'files', { kind: 'issue', state: 'open' })
    expect(gh.calls.filter(isSync)).toHaveLength(1)
  })

  it('asks GitHub directly for a number the copy does not have yet', async () => {
    const { gh, service } = setup((args) => (isSync(args) ? lines() : ok(JSON.stringify({ ...RAW_ISSUE, number: 500 }))))
    const found = await service.search('/repo', '#500', { kind: 'issue', state: 'open' })
    expect(found.items.map((item) => item.number)).toEqual([500])
    expect(gh.calls.at(-1)).toEqual(['api', 'repos/acme/app/issues/500'])
  })

  it('answers with no items when GitHub is not available', async () => {
    const { gh, service } = setup(() => ok(), { ...READY, state: 'unauthenticated' })
    expect((await service.search('/repo', '', { kind: 'issue', state: 'open' })).items).toEqual([])
    expect(gh.calls).toEqual([])
  })

  it('reads a thread once, and again only after the issue changed', async () => {
    let updated = RAW_ISSUE.updated_at
    const { gh, clock, service } = setup((args) => {
      if (isSync(args)) return lines({ ...RAW_ISSUE, updated_at: updated })
      if (args.includes('--paginate')) return lines({ event: 'commented', id: 9, user: { login: 'sanzog' }, body: 'hi' }, { event: 'mentioned' })
      return ok(JSON.stringify({ ...RAW_ISSUE, updated_at: updated }))
    })
    const thread = await service.read('/repo', 249)
    expect(thread).toMatchObject({ number: 249, body: 'TBD', repo: 'acme/app' })
    expect(thread.timeline.map((item) => item.type)).toEqual(['comment'])
    await service.read('/repo', 249)
    const reads = () => gh.calls.filter((args) => args.includes('repos/acme/app/issues/249')).length
    expect(reads()).toBe(1)

    updated = '2026-10-12T12:30:00Z'
    clock.now += 10 * 60_000
    await service.search('/repo', '', { kind: 'issue', state: 'open' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await service.read('/repo', 249)
    expect(reads()).toBe(2)
  })

  it('retries an attachment with the gh login when GitHub refuses it', async () => {
    const seen: Array<string | undefined> = []
    const fetcher = (async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization
      seen.push(auth)
      return auth ? new Response('# Plan', { status: 200, headers: { 'content-type': 'text/markdown' } }) : new Response('', { status: 404 })
    }) as typeof fetch
    const service = new IssuesService({ gh: fakeGh(() => ok('secret\n')), status: async () => READY, cache: new IssueCache(openDb(':memory:')), fetch: fetcher })
    const file = await service.attachment('/repo', 'https://github.com/user-attachments/files/1/plan.md')
    expect(file).toMatchObject({ name: 'plan.md', text: '# Plan', contentType: 'text/markdown' })
    expect(seen).toEqual([undefined, 'token secret'])
  })

  it('refuses a URL that is not a GitHub attachment', async () => {
    const { service } = setup(() => ok())
    await expect(service.attachment('/repo', 'https://example.com/x.md')).rejects.toMatchObject({ status: 400 })
  })
})

describe('IssueCache', () => {
  it('matches every word of a title, literally, and a number', () => {
    const cache = new IssueCache(openDb(':memory:'))
    cache.save('acme/app', [toIssueSummary(RAW_ISSUE), toIssueSummary({ ...RAW_ISSUE, number: 7, title: '100% coverage_report' })])
    const open = { kind: 'issue', state: 'open' } as const
    expect(cache.search('acme/app', 'files s3', open).map((i) => i.number)).toEqual([249])
    expect(cache.search('acme/app', '100%', open).map((i) => i.number)).toEqual([7])
    expect(cache.search('acme/app', 'e_r', open).map((i) => i.number)).toEqual([7])
    expect(cache.search('acme/app', '#249', open).map((i) => i.number)).toEqual([249])
    expect(cache.search('other/repo', '', open)).toEqual([])
  })

  it('hands back the first ten, newest activity first, unless asked for more', () => {
    const cache = new IssueCache(openDb(':memory:'))
    cache.save('acme/app', Array.from({ length: 15 }, (_, i) => toIssueSummary({ ...RAW_ISSUE, number: i + 1, updated_at: `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z` })))
    const open = { kind: 'issue', state: 'open' } as const
    expect(cache.search('acme/app', '', open).map((i) => i.number)).toEqual([15, 14, 13, 12, 11, 10, 9, 8, 7, 6])
    expect(cache.search('acme/app', '', open, 20)).toHaveLength(15)
  })

  it('lists closed ones only when asked', () => {
    const cache = new IssueCache(openDb(':memory:'))
    cache.save('acme/app', [toIssueSummary({ ...RAW_ISSUE, state: 'closed' })])
    expect(cache.search('acme/app', '', { kind: 'issue', state: 'open' })).toEqual([])
    expect(cache.search('acme/app', '', { kind: 'issue', state: 'all' })).toHaveLength(1)
  })
})
