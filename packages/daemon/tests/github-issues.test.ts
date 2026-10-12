import { describe, expect, it } from 'vitest'

import { isAttachmentUrl, type GhStatus } from '@canopy/shared'

import type { GhRun, GhRunner } from '../src/github/gh'
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

describe('IssuesService', () => {
  it('looks a number up directly instead of searching', async () => {
    const gh = fakeGh(() => ok(JSON.stringify(RAW_ISSUE)))
    const service = new IssuesService({ gh, status: async () => READY })
    const found = await service.search('/repo', '#249')
    expect(found.items.map((item) => item.number)).toEqual([249])
    expect(gh.calls).toEqual([['api', 'repos/acme/app/issues/249']])
  })

  it('searches the repository for words, and remembers the answer', async () => {
    const gh = fakeGh(() => ok(JSON.stringify({ items: [RAW_ISSUE] })))
    const service = new IssuesService({ gh, status: async () => READY })
    await service.search('/repo', 's3')
    await service.search('/repo', 's3')
    expect(gh.calls).toHaveLength(1)
    expect(gh.calls[0]).toContain('q=repo:acme/app s3')
  })

  it('answers with no items when GitHub is not available', async () => {
    const gh = fakeGh(() => ok())
    const service = new IssuesService({ gh, status: async () => ({ ...READY, state: 'unauthenticated' }) })
    expect((await service.search('/repo', '')).items).toEqual([])
    expect(gh.calls).toEqual([])
  })

  it('reads a thread with its timeline', async () => {
    const gh = fakeGh((args) =>
      args.includes('--paginate')
        ? ok(`${JSON.stringify({ event: 'commented', id: 9, user: { login: 'sanzog' }, body: 'hi' })}\n${JSON.stringify({ event: 'mentioned' })}\n`)
        : ok(JSON.stringify(RAW_ISSUE))
    )
    const thread = await new IssuesService({ gh, status: async () => READY }).read('/repo', 249)
    expect(thread).toMatchObject({ number: 249, body: 'TBD', repo: 'acme/app' })
    expect(thread.timeline.map((item) => item.type)).toEqual(['comment'])
  })

  it('retries an attachment with the gh login when GitHub refuses it', async () => {
    const gh = fakeGh(() => ok('secret\n'))
    const seen: Array<string | undefined> = []
    const fetcher = (async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization
      seen.push(auth)
      return auth ? new Response('# Plan', { status: 200, headers: { 'content-type': 'text/markdown' } }) : new Response('', { status: 404 })
    }) as typeof fetch
    const file = await new IssuesService({ gh, status: async () => READY, fetch: fetcher }).attachment('/repo', 'https://github.com/user-attachments/files/1/plan.md')
    expect(file).toMatchObject({ name: 'plan.md', text: '# Plan', contentType: 'text/markdown' })
    expect(seen).toEqual([undefined, 'token secret'])
  })

  it('refuses a URL that is not a GitHub attachment', async () => {
    const service = new IssuesService({ gh: fakeGh(() => ok()), status: async () => READY })
    await expect(service.attachment('/repo', 'https://example.com/x.md')).rejects.toMatchObject({ status: 400 })
  })
})
