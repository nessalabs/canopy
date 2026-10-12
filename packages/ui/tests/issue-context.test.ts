import { describe, expect, it } from 'vitest'

import type { IssueThread } from '@canopy/shared'

import { issueContext, issueLabel } from '@/lib/issue-context'

const THREAD: IssueThread = {
  number: 249,
  kind: 'issue',
  title: 'Move files to S3',
  state: 'OPEN',
  url: 'https://github.com/acme/app/issues/249',
  author: 'rohit',
  updatedAt: '2026-09-10T00:00:00Z',
  createdAt: '2026-08-13T15:48:06Z',
  body: 'TBD',
  repo: 'acme/app',
  timeline: [
    { type: 'event', id: 'e1', actor: 'rohit', createdAt: '2026-08-17T00:00:00Z', event: 'assigned', text: 'self-assigned this', ref: null },
    { type: 'comment', id: 'c1', author: 'sanzog', createdAt: '2026-08-20T15:18:27Z', body: 'update the ticket\n', url: null }
  ]
}

describe('issueContext', () => {
  it('gives the agent the issue and what people wrote on it, without the events', () => {
    expect(issueContext(THREAD)).toBe(
      [
        'GitHub issue #249 in acme/app (open): Move files to S3\nhttps://github.com/acme/app/issues/249',
        '@rohit opened it on 2026-08-13:\nTBD',
        '@sanzog commented on 2026-08-20:\nupdate the ticket'
      ].join('\n\n---\n\n')
    )
  })

  it('names the chip by number and title', () => {
    expect(issueLabel(THREAD)).toBe('#249 Move files to S3')
  })
})
