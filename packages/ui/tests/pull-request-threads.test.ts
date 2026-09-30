import { describe, expect, it } from 'vitest'

import type { GitHubThread } from '@canopy/shared'

import { threadAsNote, threadsAsComments } from '../src/components/git/pull-request/threads'

const thread = (over: Partial<GitHubThread>): GitHubThread => ({
  id: 'T1',
  file: 'api/auth.py',
  line: 12,
  originalLine: 12,
  side: 'new',
  resolved: false,
  outdated: false,
  comments: [
    { id: '1', author: 'sanzog03', body: 'Is this None-safe?', at: '2026-09-24T19:40:36Z', url: 'https://x/1' },
    { id: '2', author: 'rohit', body: 'Yes, guarded above.', at: '2026-09-24T20:00:00Z', url: 'https://x/2' }
  ],
  ...over
})

describe('GitHub threads in the Git tab', () => {
  it('shows each reply on the thread line as a sent, GitHub-marked comment, and skips outdated threads', () => {
    const comments = threadsAsComments([thread({}), thread({ id: 'T2', line: null, outdated: true })], 'wt', 'github.com')
    expect(comments.map((comment) => [comment.id, comment.file, comment.line, comment.side, comment.sent, comment.github?.author])).toEqual([
      ['gh:1', 'api/auth.py', 12, 'new', true, 'sanzog03'],
      ['gh:2', 'api/auth.py', 12, 'new', true, 'rohit']
    ])
    expect(comments[0]?.github).toEqual({ author: 'sanzog03', url: 'https://x/1', resolved: false, host: 'github.com' })
  })

  it('hands the agent the whole thread with each reply attributed, anchored to the original line when outdated', () => {
    expect(threadAsNote(thread({ resolved: true }))).toEqual({
      author: 'sanzog03',
      file: 'api/auth.py',
      line: 12,
      side: 'new',
      body: 'sanzog03: Is this None-safe?\nrohit: Yes, guarded above.',
      url: 'https://x/1',
      resolved: true
    })
    expect(threadAsNote(thread({ line: null, originalLine: 40, outdated: true })).line).toBe(40)
  })
})
