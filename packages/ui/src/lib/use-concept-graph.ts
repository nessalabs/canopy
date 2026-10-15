import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import type { AgentProvider, ConceptMap, ConceptMapPatch, DiffSpec, Worktree } from '@canopy/shared'

import { useApi } from '../providers/api'
import { useConceptMaps, useTranscript } from './api-hooks'
import { latestConceptGraph, pickMap } from './concept-graph'
import { sameSession } from './git-agent'
import { readStored, writeStored } from './local-store'
import { keys } from './query-keys'
import type { GitAgent } from './use-git-agent'

/** The map last on screen, per worktree, so a reload comes back to it. */
const pickedKey = (worktreeId: string): string => `canopy-concept-map:${worktreeId}`
const reviewedStoreKey = (worktreeId: string): string => `canopy-concepts-reviewed:${worktreeId}`
const focusKey = (worktreeId: string): string => `canopy-concept-focus:${worktreeId}`

/**
 * One worktree's Concept Graph pane state. The daemon keeps every map made of the pull request,
 * each pinned to the two commits it was cut from, so they survive a push and several can sit side
 * by side. Each runs as a Git Agent conversation of its own: the pane sends it a brief, follows the
 * picked map's answers, and keeps the newest — so "split concept 2" in that chat redraws the pane.
 */
export function useConceptGraph(worktree: Worktree, agent: GitAgent, enabled = true) {
  const api = useApi()
  const queryClient = useQueryClient()
  // Idle while the pane is closed: the hook lives in the Git tab, so without this it fetches maps
  // and follows the last mapping transcript for a reviewer who is reading Changes.
  const maps = useConceptMaps(worktree.id, enabled).data ?? []
  const key = pickedKey(worktree.id)
  const [picked, setPicked] = useState(() => readStored<string>(key))
  const map = pickMap(maps, picked)
  const pick = (id: string): void => {
    writeStored(key, id)
    setPicked(id)
  }

  const store = useCallback(
    (change: (current: ConceptMap[]) => ConceptMap[]) => queryClient.setQueryData<ConceptMap[]>(keys.conceptMaps(worktree.id), (current) => change(current ?? [])),
    [queryClient, worktree.id]
  )
  const patch = useCallback(
    async (id: string, fields: ConceptMapPatch) => {
      const updated = await api.updateConceptMap(worktree.id, id, fields)
      store((current) => current.map((candidate) => (candidate.id === id ? updated : candidate)))
    },
    [api, worktree.id, store]
  )

  // A map's tab learns its session from the first turn; the map keeps it, so the map and its chat
  // can be found again once the tab is closed. A binding is forgotten only once it is saved.
  const [started, setStarted] = useState<Record<string, string>>({})
  const binding = useRef(new Set<string>())
  useEffect(() => {
    for (const [id, tabId] of Object.entries(started)) {
      const session = agent.tabs.find((tab) => tab.id === tabId)?.session
      if (!session || binding.current.has(id)) continue
      binding.current.add(id)
      patch(id, { session })
        .then(
          () => setStarted(({ [id]: _bound, ...rest }) => rest),
          () => undefined
        )
        .finally(() => binding.current.delete(id))
    }
  }, [agent.tabs, started, patch])

  const transcript = useTranscript(enabled ? map?.session : undefined, worktree.path).data
  const latest = useMemo(
    () => (map && transcript ? latestConceptGraph(transcript.events, map.ids, map.fingerprint, map.headSha ?? undefined) : undefined),
    [transcript, map]
  )
  // Each newer answer is kept, so the map still reads once the session's transcript is gone.
  const sent = useRef<Record<string, string>>({})
  useEffect(() => {
    if (!map || !latest) return
    const json = JSON.stringify(latest)
    if (sent.current[map.id] === json || json === JSON.stringify(map.result)) return
    sent.current[map.id] = json
    // Forgetting a failed write lets the next render try again: the answer is still in the
    // transcript, so a save that lost the network is not a map the reviewer loses.
    patch(map.id, { result: latest }).catch(() => {
      if (sent.current[map.id] === json) delete sent.current[map.id]
    })
  }, [latest, map, patch])

  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState<unknown>()
  const build = async (instructions: string, provider: AgentProvider): Promise<void> => {
    const wording = instructions.trim()
    setPreparing(true)
    setError(undefined)
    try {
      const { map: made, prompt } = await api.startConceptMap(worktree.id, wording ? { instructions: wording } : {})
      const tabId = agent.startTask(provider, wording ? `Map this pull request: ${wording}` : 'Map this pull request as concepts.', prompt)
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
    await api.deleteConceptMap(worktree.id, id)
    store((current) => current.filter((candidate) => candidate.id !== id))
  }

  const tab = map ? agent.tabs.find((candidate) => candidate.id === started[map.id] || sameSession(candidate.session, map.session)) : undefined
  const status = tab ? agent.statuses[tab.id] : undefined
  const session = map?.session
  const openChat = tab
    ? () => {
        agent.activate(tab.id)
        agent.setOpen(true)
      }
    : session
      ? () => agent.show(session)
      : undefined

  const [reviewed, setReviewed] = useState(() => new Set(readStored<string[]>(reviewedStoreKey(worktree.id)) ?? []))
  const setReviewedOne = useCallback(
    (refsKey: string, on: boolean) =>
      setReviewed((current) => {
        const next = new Set(current)
        if (on) next.add(refsKey)
        else next.delete(refsKey)
        writeStored(reviewedStoreKey(worktree.id), [...next])
        return next
      }),
    [worktree.id]
  )

  // Which concept the map is looking inside, remembered per worktree: a reviewer who drilled into
  // one part of the change comes back to it rather than to the top box.
  const [focus, setFocusState] = useState(() => readStored<string>(focusKey(worktree.id)) ?? 'root')
  const setFocus = (next: string): void => {
    writeStored(focusKey(worktree.id), next)
    setFocusState(next)
  }

  const [before, after] = [map?.before, map?.after]
  const spec = useMemo<DiffSpec | undefined>(() => (before && after ? { kind: 'trees', before, after } : undefined), [before, after])
  return {
    maps,
    map,
    pick,
    remove,
    result: latest ?? map?.result,
    /** The two commits the picked map was cut from: its hunks read from here, pushed or not. */
    spec,
    instructions: map?.instructions ?? '',
    providers: agent.providers,
    build,
    /** Fetching the brief, or the mapping conversation is answering. */
    running: preparing || status === 'running' || status === 'input',
    error,
    /** Opens the mapping conversation in the Git Agent — reopening its tab if it was closed. */
    openChat,
    reviewed,
    setReviewed: setReviewedOne,
    focus,
    setFocus
  }
}
