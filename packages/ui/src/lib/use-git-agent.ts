import { useEffect, useState } from 'react'

import { taskMessage, type AgentProvider, type ReviewRequest, type SessionRef } from '@canopy/shared'

import { useProviders } from './api-hooks'
import { activate, bindSession, closeTab, gitAgentKey, mostPressing, NO_TABS, openTab, persisted, sameSession, type AgentStatus, type AgentTab, type AgentTabs } from './git-agent'
import { readStored, writeStored } from './local-store'
import type { ReviewTarget } from './use-agent-turn'
import { useStagingBoard, type StagedText } from './use-staging'

/** Whether the Git Agent was last left open, so it stays where the reader put it. */
const OPEN_KEY = 'canopy-git-agent-open'

/** Comments on their way to a tab, sent once that tab's conversation is the one it names. */
export interface PendingReview {
  target: ReviewTarget
  request: Omit<ReviewRequest, 'provider' | 'sessionId'>
  summary: string
}

/**
 * What waits for a tab's conversation and is sent once it is the one named: a review, or a plain
 * message — a task another pane started, such as grouping the change.
 */
export type Outgoing = ({ kind: 'review' } & PendingReview) | { kind: 'message'; target: ReviewTarget; text: string }

const newId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

/**
 * The Git Agent's state, owned by the Git tab so every pane can reach it: its tabs, whether it is
 * open, what is staged on each tab, reviews waiting to be sent, and how each tab is doing. Tabs
 * whose conversation exists outlive a reload; the rest are drafts and go with the page.
 */
export function useGitAgent(worktreeId: string) {
  const key = gitAgentKey(worktreeId)
  const [state, setState] = useState<AgentTabs>(() => readStored<AgentTabs>(key) ?? NO_TABS)
  useEffect(() => writeStored(key, persisted(state)), [key, state])
  const [open, setOpenState] = useState(() => readStored<boolean>(OPEN_KEY) === true)
  const setOpen = (next: boolean): void => {
    writeStored(OPEN_KEY, next)
    setOpenState(next)
  }
  const board = useStagingBoard()
  const [outbox, setOutbox] = useState<Record<string, Outgoing>>({})
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({})
  const providers = useProviders().data ?? []

  const add = (tab: Omit<AgentTab, 'id'>): string => {
    const id = newId()
    setState((current) => openTab(current, { ...tab, id }))
    setOpen(true)
    return id
  }
  const newTab = (provider: AgentProvider): string => add({ provider })

  /** Stages context on the tab on screen — on a new one when there is none — and shows it. */
  const ask = (item: Omit<StagedText, 'id'>): void => {
    const [first] = providers
    const id = state.active ?? (first ? newTab(first) : undefined)
    if (!id) return
    setOpen(true)
    board.forKey(id).stage(item)
  }

  /** A review goes to the tab already holding its session, or to a tab of its own. */
  const sendReview = (review: PendingReview): void => {
    const ref: SessionRef | undefined = review.target.sessionId ? { provider: review.target.provider, sessionId: review.target.sessionId } : undefined
    const existing = ref ? state.tabs.find((tab) => sameSession(tab.session, ref)) : undefined
    const id = existing?.id ?? add({ provider: review.target.provider, session: ref })
    if (existing) setState((current) => activate(current, existing.id))
    setOpen(true)
    setOutbox((current) => ({ ...current, [id]: { kind: 'review', ...review } }))
  }

  /**
   * Starts a task in a tab of its own: a new conversation with `provider` that opens with the
   * brief, shown in its transcript as `title`. Returns that tab.
   */
  const startTask = (provider: AgentProvider, title: string, brief: string): string => {
    const id = add({ provider })
    setOutbox((current) => ({ ...current, [id]: { kind: 'message', target: { provider, sessionId: null }, text: taskMessage(title, brief) } }))
    return id
  }

  return {
    tabs: state.tabs,
    active: state.active,
    open,
    setOpen,
    providers,
    newTab,
    activate: (id: string) => setState((current) => activate(current, id)),
    close: (id: string) => setState((current) => closeTab(current, id)),
    bind: (id: string, session: SessionRef) => setState((current) => bindSession(current, id, session)),
    staging: board.forKey,
    ask,
    sendReview,
    startTask,
    outbox,
    sent: (id: string) => setOutbox(({ [id]: _sent, ...rest }) => rest),
    statuses,
    report: (id: string, status: AgentStatus) => setStatuses((current) => (current[id] === status ? current : { ...current, [id]: status })),
    /** The most pressing state across every tab, for the toggle that opens the panel. */
    status: mostPressing(state.tabs.map((tab) => statuses[tab.id] ?? 'idle'))
  }
}

export type GitAgent = ReturnType<typeof useGitAgent>
