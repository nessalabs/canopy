import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { presetSpec, type AgentProvider, type DiffSpec, type GraphPatch, type GraphPreset, type GraphRecord, type GraphScope, type Worktree } from '@canopy/shared'

import { useApi } from '../providers/api'
import { useGraphs, useTranscript } from './api-hooks'
import { sameSession } from './git-agent'
import { readStored, writeStored } from './local-store'
import { keys } from './query-keys'
import { latestGraph, pickGraph, scopeLabel } from './review-graph'
import type { GitAgent } from './use-git-agent'

/** The graph last on screen, per worktree, so a reload comes back to it. */
const pickedKey = (worktreeId: string): string => `canopy-graph:${worktreeId}`
/** Ticks, kept by the hunks they cover. Groups kept them under the same keys, so a review in progress carries over. */
const reviewedKey = (worktreeId: string): string => `canopy-graph-reviewed:${worktreeId}`
const oldReviewedKey = (worktreeId: string): string => `canopy-groups-reviewed:${worktreeId}`

/**
 * One worktree's Graph pane state. The daemon keeps every graph made of the worktree's change —
 * of any scope, about anything — each pinned to the trees it was cut from, so they survive a
 * commit and several can sit side by side. Each runs as a Git Agent conversation in a tab of its
 * own: the pane sends it a brief, follows the picked graph's answers, and keeps the newest one — so
 * "merge 3 and 4" in that chat redraws the pane. Ticks are kept per worktree.
 */
export function useReviewGraph(worktree: Worktree, agent: GitAgent) {
  const api = useApi()
  const queryClient = useQueryClient()
  const listed = useGraphs(worktree.id)
  const graphs = listed.data ?? []
  const key = pickedKey(worktree.id)
  const [picked, setPicked] = useState(() => ({ key, id: readStored<string>(key) }))
  if (picked.key !== key) setPicked({ key, id: readStored<string>(key) })
  const graph = pickGraph(graphs, picked.key === key ? picked.id : undefined)
  const pick = (id: string): void => {
    writeStored(key, id)
    setPicked({ key, id })
  }

  const store = useCallback(
    (change: (current: GraphRecord[]) => GraphRecord[]) => queryClient.setQueryData<GraphRecord[]>(keys.graphs(worktree.id), (current) => change(current ?? [])),
    [queryClient, worktree.id]
  )
  const patch = useCallback(
    async (id: string, fields: GraphPatch) => {
      const updated = await api.updateGraph(worktree.id, id, fields)
      store((current) => current.map((candidate) => (candidate.id === id ? updated : candidate)))
    },
    [api, worktree.id, store]
  )

  // A graph's tab learns its session from the first turn; the graph keeps it, so its answers and
  // its chat can be found again once the tab is closed. A binding is forgotten only once saved.
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

  const transcript = useTranscript(graph?.session, worktree.path).data
  const latest = useMemo(() => (graph && transcript ? latestGraph(transcript.events, graph.ids, graph.fingerprint, graph.headSha) : undefined), [transcript, graph])
  // Each newer answer is kept, so the graph still reads once the session's transcript is gone.
  const sent = useRef<Record<string, string>>({})
  useEffect(() => {
    if (!graph || !latest) return
    const json = JSON.stringify(latest)
    if (sent.current[graph.id] === json || json === JSON.stringify(graph.result)) return
    sent.current[graph.id] = json
    void patch(graph.id, { result: latest })
  }, [latest, graph, patch])

  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState<unknown>()
  const make = async (input: { scope: GraphScope; preset: GraphPreset; instructions: string; provider: AgentProvider }): Promise<void> => {
    const wording = input.instructions.trim()
    setPreparing(true)
    setError(undefined)
    try {
      const { graph: made, prompt } = await api.startGraph(worktree.id, { scope: input.scope, preset: input.preset, ...(wording ? { instructions: wording } : {}) })
      const title = `Graph ${presetSpec(input.preset).label.toLowerCase()} · ${scopeLabel(input.scope)}${wording ? `: ${wording}` : ''}`
      const tabId = agent.startTask(input.provider, title, prompt)
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
    await api.deleteGraph(worktree.id, id)
    store((current) => current.filter((candidate) => candidate.id !== id))
  }

  const tab = graph ? agent.tabs.find((candidate) => candidate.id === started[graph.id] || sameSession(candidate.session, graph.session)) : undefined
  const status = tab ? agent.statuses[tab.id] : undefined
  const session = graph?.session
  const openChat = tab
    ? () => {
        agent.activate(tab.id)
        agent.setOpen(true)
      }
    : session
      ? () => agent.show(session)
      : undefined

  const [reviewed, setReviewed] = useState(() => new Set(readStored<string[]>(reviewedKey(worktree.id)) ?? readStored<string[]>(oldReviewedKey(worktree.id)) ?? []))
  const setReviewedOne = useCallback(
    (refsKey: string, on: boolean) =>
      setReviewed((current) => {
        if (current.has(refsKey) === on) return current
        const next = new Set(current)
        if (on) next.add(refsKey)
        else next.delete(refsKey)
        writeStored(reviewedKey(worktree.id), [...next])
        return next
      }),
    [worktree.id]
  )

  const [before, after] = [graph?.before, graph?.after]
  const spec = useMemo<DiffSpec | undefined>(() => (before && after ? { kind: 'trees', before, after } : undefined), [before, after])
  return {
    graphs,
    record: graph,
    pick,
    remove,
    result: latest ?? graph?.result,
    /** The trees the picked graph was cut from: its hunks read from here, committed or not. */
    spec,
    providers: agent.providers,
    make,
    /** Fetching the brief, or the graph conversation is answering. */
    running: preparing || status === 'running' || status === 'input',
    /** Making a graph failed, or the daemon could not list them. */
    error: error ?? listed.error ?? undefined,
    /** Opens the graph conversation in the Git Agent — reopening its tab if it was closed. */
    openChat,
    reviewed,
    setReviewed: setReviewedOne
  }
}

export type ReviewGraphState = ReturnType<typeof useReviewGraph>
