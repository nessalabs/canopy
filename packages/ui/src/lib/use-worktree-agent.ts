import { useEffect, useMemo, useRef, useState } from 'react'

import type { AgentProvider, Autonomy, Effort, SessionRef, TurnOptions, Worktree } from '@canopy/shared'

import { useAgentCapabilities, useAgentSessions, usePinSession, useTranscript } from './api-hooks'
import { modelAlias } from './models'
import { useAgentTurn } from './use-agent-turn'

const sameRef = (a: SessionRef | undefined, b: SessionRef | undefined): boolean =>
  a?.provider === b?.provider && a?.sessionId === b?.sessionId

/**
 * The agent conversation attached to a worktree: which session (pinned, else the most
 * recent one that ran in this checkout) and the live turn state. Lifted above the tabs
 * so "Send comments for review" on the diff drives the same conversation the Agent tab shows.
 */
export function useWorktreeAgent(worktree: Worktree) {
  const sessions = useAgentSessions(worktree.id)
  const pin = usePinSession(worktree.id)
  const [chosen, setChosen] = useState<SessionRef>()
  // Set while composing the first message of a new session; cleared once the agent names it.
  const [fresh, setFresh] = useState<AgentProvider>()
  const [autonomy, setAutonomy] = useState<Autonomy>('edit')
  // Per-turn overrides; undefined means "whatever the session was already using".
  const [modelOverride, setModel] = useState<string>()
  const [effortOverride, setEffort] = useState<Effort>()

  const list = sessions.data?.sessions ?? []
  const pinned = sessions.data?.pinned
  const selected = useMemo(() => {
    if (fresh) return undefined
    const preferred = chosen ?? pinned
    return list.find((s) => sameRef(s, preferred)) ?? list[0]
  }, [chosen, fresh, pinned, list])

  useEffect(() => {
    if (chosen && !list.some((s) => sameRef(s, chosen))) setChosen(undefined)
  }, [chosen, list])

  const select = (ref: SessionRef): void => {
    setFresh(undefined)
    setChosen(ref)
    setModel(undefined)
    setEffort(undefined)
    pin.mutate(ref)
  }

  const startSession = (provider: AgentProvider): void => {
    setFresh(provider)
    setModel(undefined)
    setEffort(undefined)
  }

  const ref = selected ? { provider: selected.provider, sessionId: selected.sessionId } : undefined
  // The turn hook needs history (detected model); the poll needs the turn's busy flag. A ref breaks the cycle.
  const busyRef = useRef(false)
  const history = useTranscript(ref, worktree.path, () => busyRef.current)
  const detected = { model: modelAlias(history.data?.model), effort: history.data?.effort }
  const model = modelOverride ?? detected.model
  const effort = effortOverride ?? detected.effort
  const options = useMemo<TurnOptions>(() => ({ autonomy, model, effort }), [autonomy, model, effort])
  const turn = useAgentTurn(worktree.id, ref, fresh, worktree.path, options)
  busyRef.current = turn.busy
  // What this provider can do in this checkout: the `/` and `@` menus, the model list, the details sheet.
  const capabilities = useAgentCapabilities(worktree.id, selected?.provider ?? fresh, selected?.sessionId)

  // A knob moved mid-turn is meant for the turn on screen, so it goes to the running one as well.
  const chooseModel = (next: string): void => {
    setModel(next)
    if (turn.busy) void turn.setLiveControls({ model: next })
  }
  const chooseAutonomy = (next: Autonomy): void => {
    setAutonomy(next)
    if (turn.busy) void turn.setLiveControls({ autonomy: next })
  }

  // The new session exists once its first turn ends: list it, then make it the selection.
  const createdId = fresh && !turn.busy ? turn.sessionId : null
  useEffect(() => {
    if (!fresh || !createdId) return
    void sessions.refetch().then(() => select({ provider: fresh, sessionId: createdId }))
  }, [createdId])

  return {
    sessions: list,
    selected,
    select,
    fresh,
    startSession,
    history,
    capabilities: capabilities.data,
    autonomy,
    setAutonomy: chooseAutonomy,
    model,
    setModel: chooseModel,
    effort,
    setEffort,
    loading: sessions.isPending,
    error: sessions.error,
    turn
  }
}

export type WorktreeAgent = ReturnType<typeof useWorktreeAgent>
