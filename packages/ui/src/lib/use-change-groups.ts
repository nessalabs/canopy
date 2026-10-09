import { useCallback, useEffect, useMemo, useState } from 'react'

import type { AgentProvider, Against, ChangeGroups, HunkIds, SessionRef, Worktree } from '@canopy/shared'

import { useApi } from '../providers/api'
import { useTranscript } from './api-hooks'
import { latestGrouping } from './change-groups'
import { readStored, writeStored } from './local-store'
import type { GitAgent } from './use-git-agent'

/** The grouping session: its tab, its conversation once it has one, and the ids its answers name hunks by. */
interface GroupingRun {
  tabId: string
  session?: SessionRef
  ids: HunkIds
  fingerprint: string
}

/** A worktree's grouping as last seen: the wording it was asked with, its session, and the groups it last answered. */
interface Stored {
  instructions: string
  run?: GroupingRun
  result?: ChangeGroups
}

const EMPTY: Stored = { instructions: '' }

const resultKey = (worktreeId: string, against: Against): string => `canopy-groups:${worktreeId}:${against}`
const reviewedKey = (worktreeId: string): string => `canopy-groups-reviewed:${worktreeId}`

/**
 * One worktree's Groups pane state. Grouping runs as a Git Agent conversation in a tab of its
 * own: the pane sends it a brief, follows its answers, and draws the newest grouping it gave — so
 * "merge 3 and 4" in that chat regroups the pane. The last grouping is kept across reloads, and
 * so are the sections ticked off as reviewed.
 */
export function useChangeGroups(worktree: Worktree, against: Against, agent: GitAgent) {
  const api = useApi()
  const key = resultKey(worktree.id, against)
  const [state, setState] = useState(() => ({ key, stored: readStored<Stored>(key) ?? EMPTY }))
  // Head and base keep a grouping each; switching between them reads the other one back.
  if (state.key !== key) setState({ key, stored: readStored<Stored>(key) ?? EMPTY })
  const stored = state.key === key ? state.stored : EMPTY
  const update = useCallback(
    (change: (current: Stored) => Stored) =>
      setState((current) => {
        const next = change(current.key === key ? current.stored : EMPTY)
        writeStored(key, next)
        return { key, stored: next }
      }),
    [key]
  )

  const run = stored.run
  const tab = run ? agent.tabs.find((candidate) => candidate.id === run.tabId) : undefined
  // The tab learns its session from the first turn; the run keeps it so a closed tab's groups still read.
  useEffect(() => {
    if (tab?.session && !run?.session) update((current) => (current.run ? { ...current, run: { ...current.run, session: tab.session } } : current))
  }, [tab?.session, run?.session, update])

  const transcript = useTranscript(run?.session ?? tab?.session, worktree.path).data
  const latest = useMemo(() => (run && transcript ? latestGrouping(transcript.events, run.ids, run.fingerprint) : undefined), [transcript, run])
  useEffect(() => {
    if (latest && JSON.stringify(latest) !== JSON.stringify(stored.result)) update((current) => ({ ...current, result: latest }))
  }, [latest])

  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState<unknown>()
  const group = async (instructions: string, provider: AgentProvider): Promise<void> => {
    const wording = instructions.trim()
    setPreparing(true)
    setError(undefined)
    try {
      const brief = await api.groupBrief(worktree.id, { against, ...(wording ? { instructions: wording } : {}) })
      const tabId = agent.startTask(provider, wording ? `Group this change: ${wording}` : 'Group this change into features.', brief.prompt)
      update((current) => ({ ...current, instructions, run: { tabId, ids: brief.ids, fingerprint: brief.fingerprint } }))
    } catch (failure) {
      setError(failure)
    } finally {
      setPreparing(false)
    }
  }

  const status = run ? agent.statuses[run.tabId] : undefined
  const openChat = tab
    ? () => {
        agent.activate(tab.id)
        agent.setOpen(true)
      }
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

  return {
    result: stored.result,
    instructions: stored.instructions,
    providers: agent.providers,
    group,
    /** Fetching the brief, or the grouping conversation is answering. */
    running: preparing || status === 'running' || status === 'input',
    error,
    /** Opens the grouping conversation in the Git Agent, while its tab is open. */
    openChat,
    reviewed,
    setReviewed: setReviewedOne
  }
}
