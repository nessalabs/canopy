import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { presetSpec, type AgentProvider, type DiffSpec, type GraphPatch, type GraphPreset, type GraphRecord, type GraphScope, type ReviewGraph, type Worktree } from '@canopy/shared'

import { useApi } from '../providers/api'
import { useGraphs, useTranscript } from './api-hooks'
import { sameSession } from './git-agent'
import { readStored, writeStored } from './local-store'
import { keys } from './query-keys'
import { latestGraph, pickGraph, reviewedKey as refsKeyOf, scopeLabel } from './review-graph'
import type { GitAgent } from './use-git-agent'

/** The graph last on screen, per worktree, so a reload comes back to it. */
const pickedKey = (worktreeId: string): string => `canopy-graph:${worktreeId}`
/** Ticks, kept by the graph they were made in and the hunks they cover. */
const reviewedKey = (worktreeId: string): string => `canopy-graph-reviewed:${worktreeId}`
const oldReviewedKey = (worktreeId: string): string => `canopy-groups-reviewed:${worktreeId}`
/** A path never holds a NUL, so it parts a tick's graph from its hunks. */
const TICK = '\u0000'
const tickOf = (graphId: string, refsKey: string): string => `${graphId}${TICK}${refsKey}`

/**
 * Ticks from before they were kept per graph — the Groups pane's, and the first Graph pane's —
 * name hunks alone, so a tick in one graph showed in every graph that shared a hunk. Each is
 * handed to the graphs it ticks a node of (a converted grouping keeps its review) and then let go.
 */
export function adoptTicks(ticks: readonly string[], graphs: readonly Pick<GraphRecord, 'id' | 'result'>[]): string[] {
  const kept = ticks.filter((tick) => tick.includes(TICK))
  const loose = new Set(ticks.filter((tick) => !tick.includes(TICK)))
  if (loose.size === 0) return [...ticks]
  const adopted = graphs.flatMap((graph) => (graph.result?.nodes ?? []).map((node) => refsKeyOf(node.refs)).filter((key) => loose.has(key)).map((key) => tickOf(graph.id, key)))
  return [...new Set([...kept, ...adopted])]
}

/** The same graph object for as long as its content is the same, so a re-read answer does not look new. */
function useSameGraph(graph: ReviewGraph | undefined): ReviewGraph | undefined {
  const held = useRef<{ json: string; graph: ReviewGraph } | undefined>(undefined)
  if (!graph) return undefined
  const json = JSON.stringify(graph)
  if (held.current?.json !== json) held.current = { json, graph }
  return held.current.graph
}

/**
 * One worktree's Graph pane state. The daemon keeps every graph made of the worktree's change —
 * of any scope, about anything — each pinned to the trees it was cut from, so they survive a
 * commit and several can sit side by side. Each runs as a Git Agent conversation in a tab of its
 * own: the pane sends it a brief, follows the picked graph's answers, and keeps the newest one — so
 * "merge 3 and 4" in that chat redraws the pane. Ticks are kept per graph.
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
    setError(undefined)
    try {
      await api.deleteGraph(worktree.id, id)
      store((current) => current.filter((candidate) => candidate.id !== id))
    } catch (failure) {
      setError(failure)
    }
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

  const [ticks, setTicks] = useState(() => new Set(readStored<string[]>(reviewedKey(worktree.id)) ?? readStored<string[]>(oldReviewedKey(worktree.id)) ?? []))
  // Ticks from before they were kept per graph go to the graphs they tick, once the graphs are in.
  useEffect(() => {
    if (!listed.data || ![...ticks].some((tick) => !tick.includes(TICK))) return
    const next = new Set(adoptTicks([...ticks], listed.data))
    writeStored(reviewedKey(worktree.id), [...next])
    setTicks(next)
  }, [listed.data, ticks, worktree.id])
  const graphId = graph?.id
  // The picked graph's ticks, by the hunks they cover: what the views compare a node against.
  const reviewed = useMemo(() => {
    const prefix = graphId === undefined ? undefined : tickOf(graphId, '')
    return new Set(prefix === undefined ? [] : [...ticks].filter((tick) => tick.startsWith(prefix)).map((tick) => tick.slice(prefix.length)))
  }, [ticks, graphId])
  const setReviewedOne = useCallback(
    (refsKey: string, on: boolean) => {
      if (graphId === undefined) return
      const tick = tickOf(graphId, refsKey)
      setTicks((current) => {
        if (current.has(tick) === on) return current
        const next = new Set(current)
        if (on) next.add(tick)
        else next.delete(tick)
        writeStored(reviewedKey(worktree.id), [...next])
        return next
      })
    },
    [worktree.id, graphId]
  )
  const result = useSameGraph(latest ?? graph?.result)

  const [before, after] = [graph?.before, graph?.after]
  const spec = useMemo<DiffSpec | undefined>(() => (before && after ? { kind: 'trees', before, after } : undefined), [before, after])
  return {
    graphs,
    record: graph,
    pick,
    remove,
    /** The picked graph's newest answer; the same object until its content changes. */
    result,
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
