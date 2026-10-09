/**
 * Claude's commit and pull-request drafts, held outside any component (see `jobs.ts`), so a draft
 * started on one worktree fills that worktree's form whenever it is next on screen.
 */
import { useCallback } from 'react'

import type { DraftInput, DraftKind, TextDraft } from '@canopy/shared'

import { useApi } from '../providers/api'
import { createJobStore, useJob } from './jobs'

const drafts = createJobStore<TextDraft>()

const keyOf = (worktreeId: string, kind: DraftKind): string => `${worktreeId}:${kind}`

/** Starts a draft unless one for the same worktree and kind is already running. */
export const startDraft = (worktreeId: string, input: DraftInput, run: (input: DraftInput) => Promise<TextDraft>): void =>
  drafts.start(keyOf(worktreeId, input.kind), () => run(input))

/** Hands a finished draft to the caller and forgets it, so it fills the form exactly once. */
export const takeDraft = (worktreeId: string, kind: DraftKind): TextDraft | undefined => drafts.take(keyOf(worktreeId, kind))

/**
 * One worktree's draft of one kind. `onDraft` fills the form when a draft lands, including one
 * that finished while this form was not mounted; `dismiss` clears a failure the user has read.
 */
export function useDraftJob(worktreeId: string, kind: DraftKind, onDraft: (draft: TextDraft) => void) {
  const api = useApi()
  const job = useJob(drafts, keyOf(worktreeId, kind), onDraft)
  const start = useCallback((input: DraftInput) => startDraft(worktreeId, input, (body) => api.draft(worktreeId, body)), [api, worktreeId])
  return { ...job, start }
}
