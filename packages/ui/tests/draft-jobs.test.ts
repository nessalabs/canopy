import { describe, expect, it } from 'vitest'

import type { DraftInput, TextDraft } from '@canopy/shared'

import { startDraft, takeDraft } from '../src/lib/draft-jobs'

const deferred = () => {
  let resolve!: (draft: TextDraft) => void
  const promise = new Promise<TextDraft>((done) => (resolve = done))
  return { promise, resolve }
}

describe('draft jobs', () => {
  it('keeps a finished draft until a form takes it, then forgets it', async () => {
    const pending = deferred()
    startDraft('wt-1', { kind: 'commit' }, () => pending.promise)
    expect(takeDraft('wt-1', 'commit')).toBeUndefined()

    pending.resolve({ title: 'Add drafts', body: '' })
    await pending.promise
    expect(takeDraft('wt-1', 'pullRequest')).toBeUndefined()
    expect(takeDraft('wt-1', 'commit')).toEqual({ title: 'Add drafts', body: '' })
    expect(takeDraft('wt-1', 'commit')).toBeUndefined()
  })

  it('does not start a second request while one is running for the same worktree and kind', async () => {
    const pending = deferred()
    const calls: DraftInput[] = []
    const run = (input: DraftInput) => (calls.push(input), pending.promise)
    startDraft('wt-2', { kind: 'commit' }, run)
    startDraft('wt-2', { kind: 'commit' }, run)
    expect(calls).toHaveLength(1)
    pending.resolve({ title: 'x', body: '' })
    await pending.promise
  })
})
