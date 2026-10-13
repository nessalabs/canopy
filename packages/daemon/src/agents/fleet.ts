/**
 * Every agent Canopy can see, across all projects, and what each is doing now — the Agents
 * panel's one read. A worktree's own listing already knows its sessions and whether a terminal or
 * a hook says they are busy; this adds what only the daemon knows (a turn it runs, a permission
 * ask parked in it) and which sessions are Canopy's own, then flattens the lot.
 */
import type { AgentActivity, AgentProvider, AgentSessionSummary, FleetAgent } from '@canopy/shared'

import type { GitAgentStore } from '../git-agent/store'
import type { WorktreeRow } from '../worktrees/service'
import type { SessionLister } from './sessions'

/** Recent sessions read per checkout: the panel is about now, not a full history. */
export const FLEET_PER_WORKTREE = 10

const key = (ref: { provider: string; sessionId: string }): string => `${ref.provider}:${ref.sessionId}`

/** A parked ask outranks everything: the agent is running, but it is waiting on a person. */
export function activityOf(session: AgentSessionSummary, awaiting: boolean): AgentActivity {
  if (awaiting) return 'approval'
  return session.running || session.status === 'busy' ? 'running' : 'done'
}

/** What the daemon knows about a session beyond the provider's listing. */
export interface LiveState {
  running(provider: AgentProvider, sessionId: string): boolean
  awaiting(provider: AgentProvider, sessionId: string): boolean
}

/** One listed session as the panel shows it. */
export function toFleetAgent(worktree: Pick<WorktreeRow, 'id' | 'project_id'>, session: AgentSessionSummary, canopy: ReadonlySet<string>, live: LiveState): FleetAgent {
  const running = session.running || live.running(session.provider, session.sessionId)
  return {
    provider: session.provider,
    sessionId: session.sessionId,
    title: session.title,
    kind: canopy.has(key(session)) ? 'canopy' : 'project',
    projectId: worktree.project_id,
    worktreeId: worktree.id,
    activity: activityOf({ ...session, running }, live.awaiting(session.provider, session.sessionId)),
    updatedAt: session.updatedAt
  }
}

interface Deps {
  worktrees: { present(): WorktreeRow[] }
  sessions: SessionLister
  gitAgent: Pick<GitAgentStore, 'sessions'>
  live: LiveState
}

/**
 * Newest first, each session once. One that visits another checkout is listed there too, so the
 * visits are placed last and each session is filed under the checkout it started in. A checkout
 * whose listing fails is left out rather than failing the panel.
 */
export async function listFleet({ worktrees, sessions, gitAgent, live }: Deps): Promise<FleetAgent[]> {
  const rows = worktrees.present()
  const canopy = new Set(rows.flatMap((row) => gitAgent.sessions(row.id).map(key)))
  const lists = await Promise.all(rows.map((row) => sessions.list({ id: row.id, path: row.path }, FLEET_PER_WORKTREE).catch(() => [])))
  const listed = rows
    .flatMap((row, i) => lists[i]!.map((session) => ({ row, session })))
    .sort((a, b) => Number(Boolean(a.session.visiting)) - Number(Boolean(b.session.visiting)))
  const seen = new Set<string>()
  return listed
    .filter(({ session }) => !seen.has(key(session)) && Boolean(seen.add(key(session))))
    .map(({ row, session }) => toFleetAgent(row, session, canopy, live))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}
