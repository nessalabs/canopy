import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import type { AgentProvider, Against, ChangeGrouping, DiffSpec, GroupingPatch, Worktree } from '@canopy/shared'

import { useApi } from '../providers/api'
import { useGroupings, useTranscript } from './api-hooks'
import { latestGrouping, pickGrouping } from './change-groups'
import { sameSession } from './git-agent'
import { readStored, writeStored } from './local-store'
import { keys } from './query-keys'
import type { GitAgent } from './use-git-agent'

/** The grouping last on screen, per worktree and diff base, so a reload comes back to it. */
const pickedKey = (worktreeId: string, against: Against): string => `canopy-grouping:${worktreeId}:${against}`
const reviewedKey = (worktreeId: string): string => `canopy-groups-reviewed:${worktreeId}`

/**
 * One worktree's Groups pane state. The daemon keeps every grouping made of the change, each pinned
 * to the snapshot it was made from, so they survive a commit and several can sit side by side. Each
 * runs as a Git Agent conversation in a tab of its own: the pane sends it a brief, follows the
 * picked grouping's answers, and keeps the newest one — so "merge 3 and 4" in that chat regroups
 * the pane. The sections ticked off as reviewed are kept per worktree.
 */
export function useChangeGroups(worktree: Worktree, against: Against, agent: GitAgent) {
  const api = useApi()
  const queryClient = useQueryClient()
  const all = useGroupings(worktree.id).data
  const groupings = useMemo(() => (all ?? []).filter((grouping) => grouping.against === against), [all, against])
  const key = pickedKey(worktree.id, against)
  const [picked, setPicked] = useState(() => ({ key, id: readStored<string>(key) }))
  // Head and base remember a pick each; switching between them reads the other one back.
  if (picked.key !== key) setPicked({ key, id: readStored<string>(key) })
  const grouping = pickGrouping(groupings, picked.key === key ? picked.id : undefined)
  const pick = (id: string): void => {
    writeStored(key, id)
    setPicked({ key, id })
  }

  const store = useCallback(
    (change: (current: ChangeGrouping[]) => ChangeGrouping[]) => queryClient.setQueryData<ChangeGrouping[]>(keys.groupings(worktree.id), (current) => change(current ?? [])),
    [queryClient, worktree.id]
  )
  const patch = useCallback(
    async (id: string, fields: GroupingPatch) => {
      const updated = await api.updateGrouping(worktree.id, id, fields)
      store((current) => current.map((candidate) => (candidate.id === id ? updated : candidate)))
    },
    [api, worktree.id, store]
  )

  // A grouping's tab learns its session from the first turn; the grouping keeps it, so its groups
  // and its chat can be found again once the tab is closed.
  const [started, setStarted] = useState<Record<string, string>>({})
  useEffect(() => {
    for (const [id, tabId] of Object.entries(started)) {
      const session = agent.tabs.find((tab) => tab.id === tabId)?.session
      if (!session) continue
      setStarted(({ [id]: _bound, ...rest }) => rest)
      void patch(id, { session })
    }
  }, [agent.tabs, started, patch])

  const transcript = useTranscript(grouping?.session, worktree.path).data
  const latest = useMemo(() => (grouping && transcript ? latestGrouping(transcript.events, grouping.ids, grouping.fingerprint) : undefined), [transcript, grouping])
  // Each newer answer is kept, so the groups still read once the session's transcript is gone.
  const sent = useRef<Record<string, string>>({})
  useEffect(() => {
    if (!grouping || !latest) return
    const json = JSON.stringify(latest)
    if (sent.current[grouping.id] === json || json === JSON.stringify(grouping.result)) return
    sent.current[grouping.id] = json
    void patch(grouping.id, { result: latest })
  }, [latest, grouping, patch])

  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState<unknown>()
  const group = async (instructions: string, provider: AgentProvider): Promise<void> => {
    const wording = instructions.trim()
    setPreparing(true)
    setError(undefined)
    try {
      const { grouping: made, prompt } = await api.startGrouping(worktree.id, { against, ...(wording ? { instructions: wording } : {}) })
      const tabId = agent.startTask(provider, wording ? `Group this change: ${wording}` : 'Group this change into features.', prompt)
      setStarted((current) => ({ ...current, [made.id]: tabId }))
      store((current) => [made, ...current])
      pick(made.id)
    } catch (failure) {
      setError(failure)
    } finally {
      setPreparing(false)
    }
  }

  const remove = async (id: string): Promise<void> => {
    await api.deleteGrouping(worktree.id, id)
    store((current) => current.filter((candidate) => candidate.id !== id))
  }

  const tab = grouping ? agent.tabs.find((candidate) => candidate.id === started[grouping.id] || sameSession(candidate.session, grouping.session)) : undefined
  const status = tab ? agent.statuses[tab.id] : undefined
  const session = grouping?.session
  const openChat = tab
    ? () => {
        agent.activate(tab.id)
        agent.setOpen(true)
      }
    : session
      ? () => agent.show(session)
      : undefined

  const [reviewed, setReviewed] = useState(() => new Set(readStored<string[]>(reviewedKey(worktree.id)) ?? []))
  const setReviewedOne = useCallback(
    (refsKey: string, on: boolean) =>
      setReviewed((current) => {
        const next = new Set(current)
        if (on) next.add(refsKey)
        else next.delete(refsKey)
        writeStored(reviewedKey(worktree.id), [...next])
        return next
      }),
    [worktree.id]
  )

  const [before, after] = [grouping?.before, grouping?.after]
  const spec = useMemo<DiffSpec | undefined>(() => (before && after ? { kind: 'trees', before, after } : undefined), [before, after])
  return {
    groupings,
    grouping,
    pick,
    remove,
    result: latest ?? grouping?.result,
    /** The snapshot the picked grouping was made from: its hunks read from here, committed or not. */
    spec,
    instructions: grouping?.instructions ?? '',
    providers: agent.providers,
    group,
    /** Fetching the brief, or the grouping conversation is answering. */
    running: preparing || status === 'running' || status === 'input',
    error,
    /** Opens the grouping conversation in the Git Agent — reopening its tab if it was closed. */
    openChat,
    reviewed,
    setReviewed: setReviewedOne
  }
}
