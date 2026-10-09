/**
 * Claude's commit and pull-request drafts, held outside any component. A draft takes seconds, and
 * the user is free to switch worktrees meanwhile: the request keeps running, and whichever form
 * for that worktree is mounted when it lands — now or on a later visit — takes the result.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'

import type { DraftInput, DraftKind, TextDraft } from '@canopy/shared'

import { useApi } from '../providers/api'

export type DraftJob = { status: 'running' } | { status: 'done'; draft: TextDraft } | { status: 'error'; error: unknown }

type Run = (input: DraftInput) => Promise<TextDraft>

const jobs = new Map<string, DraftJob>()
const listeners = new Set<() => void>()

const keyOf = (worktreeId: string, kind: DraftKind): string => `${worktreeId}:${kind}`

function set(key: string, job: DraftJob | undefined): void {
  if (job) jobs.set(key, job)
  else jobs.delete(key)
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Starts a draft unless one for the same worktree and kind is already running. */
export function startDraft(worktreeId: string, input: DraftInput, run: Run): void {
  const key = keyOf(worktreeId, input.kind)
  if (jobs.get(key)?.status === 'running') return
  set(key, { status: 'running' })
  run(input).then(
    (draft) => set(key, { status: 'done', draft }),
    (error: unknown) => set(key, { status: 'error', error })
  )
}

/** Hands a finished draft to the caller and forgets it, so it fills the form exactly once. */
export function takeDraft(worktreeId: string, kind: DraftKind): TextDraft | undefined {
  const key = keyOf(worktreeId, kind)
  const job = jobs.get(key)
  if (job?.status !== 'done') return undefined
  set(key, undefined)
  return job.draft
}

/**
 * One worktree's draft of one kind. `onDraft` fills the form when a draft lands, including one
 * that finished while this form was not mounted; `dismiss` clears a failure the user has read.
 */
export function useDraftJob(worktreeId: string, kind: DraftKind, onDraft: (draft: TextDraft) => void) {
  const api = useApi()
  const key = keyOf(worktreeId, kind)
  const job = useSyncExternalStore(subscribe, () => jobs.get(key))

  const apply = useRef(onDraft)
  apply.current = onDraft
  useEffect(() => {
    const draft = job?.status === 'done' ? takeDraft(worktreeId, kind) : undefined
    if (draft) apply.current(draft)
  }, [job, worktreeId, kind])

  const start = useCallback((input: DraftInput) => startDraft(worktreeId, input, (body) => api.draft(worktreeId, body)), [api, worktreeId])
  const dismiss = useCallback(() => set(key, undefined), [key])
  return { running: job?.status === 'running', error: job?.status === 'error' ? job.error : undefined, start, dismiss }
}
