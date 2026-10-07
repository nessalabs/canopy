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
 *
 * `fixed` holds the conversation to one session — a pane opened beside the main one — which
 * neither follows nor moves the worktree's pin.
 */
export function useWorktreeAgent(worktree: Worktree, fixed?: SessionRef) {
  const sessions = useAgentSessions(worktree.id)
  const pin = usePinSession(worktree.id)
  const [chosen, setChosen] = useState<SessionRef>()
  // Set while composing the first message of a new session; cleared once the agent names it.
  const [fresh, setFresh] = useState<AgentProvider>()
  const [autonomy, setAutonomy] = useState<Autonomy>('edit')
  // Per-turn overrides; undefined means "whatever the session was already using".
  const [modelOverride, setModel] = useState<string>()
  const [effortOverride, setEffort] = useState<Effort>()

  const all = sessions.data?.sessions ?? []
  // This checkout's own sessions (and visitors) are the conversation; the ones that ran in another
  // checkout of the project are listed for reading and continuing, and are never picked for you.
  const list = useMemo(() => all.filter((s) => !s.origin), [all])
  const elsewhere = useMemo(() => all.filter((s) => s.origin), [all])
  const pinned = sessions.data?.pinned
  const selected = useMemo(() => {
    if (fresh) return undefined
    if (fixed) return all.find((s) => sameRef(s, fixed))
    const preferred = chosen ?? pinned
    return all.find((s) => sameRef(s, preferred)) ?? list[0]
  }, [fixed?.provider, fixed?.sessionId, chosen, fresh, pinned, all, list])

  useEffect(() => {
    if (chosen && !all.some((s) => sameRef(s, chosen))) setChosen(undefined)
  }, [chosen, all])

  const select = (ref: SessionRef): void => {
    setFresh(undefined)
    setChosen(ref)
    setModel(undefined)
    setEffort(undefined)
    if (!fixed) pin.mutate(ref)
  }

  const startSession = (provider: AgentProvider): void => {
    setFresh(provider)
    setModel(undefined)
    setEffort(undefined)
  }

  const ref = selected ? { provider: selected.provider, sessionId: selected.sessionId } : undefined
  // A session working here from another checkout is filed under that checkout: its transcript
  // is read there, and a message sent to it resumes it there. One from another checkout of the
  // project runs where the daemon says — the main checkout, when its own worktree is gone — while
  // its transcript is still read from where it was filed.
  const cwd = selected?.origin ? selected.origin.runIn : selected?.visiting && selected.cwd ? selected.cwd : worktree.path
  const transcriptCwd = selected?.origin ? (selected.cwd ?? selected.origin.path) : cwd
  // The turn hook needs history (detected model); the poll needs the turn's busy flag. A ref breaks the cycle.
  const busyRef = useRef(false)
  const history = useTranscript(ref, transcriptCwd, () => busyRef.current)
  const detected = { model: modelAlias(history.data?.model), effort: history.data?.effort }
  const model = modelOverride ?? detected.model
  const effort = effortOverride ?? detected.effort
  const options = useMemo<TurnOptions>(() => ({ autonomy, model, effort }), [autonomy, model, effort])
  const turn = useAgentTurn(worktree.id, ref, fresh, cwd, options)
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
    /** Sessions of the project's other checkouts: every one in the main checkout, main's in a worktree. */
    elsewhere,
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
