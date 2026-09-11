/**
 * The sessions a worktree's Agent tab lists: the ones that ran in its checkout, plus the ones
 * that worked here from another — a session started in the main checkout and told to work in
 * this worktree is this worktree's session too, whatever `~/.claude/projects` files it under.
 * Each carries what is known about whether it is still going.
 */
import type { AgentSessionSummary } from '@canopy/shared'

import { now } from '../lib/ids'
import { liveSessions, type LiveSession } from './claude-terminal'
import type { PresenceService } from './presence'
import type { AgentRegistry } from './registry'

export interface SessionLister {
  list(worktree: { id: string; path: string }, limit?: number): Promise<AgentSessionSummary[]>
}

/** A hook this recent means a tool call is running or just finished: the turn is not over. */
export const RECENT_HOOK_MS = 60_000

/**
 * What a session is doing, from the two things that can know: its terminal's registry entry,
 * which says `busy` or `idle` outright, and its hooks, whose last report dates the last tool call.
 * A session without either — a Canopy-launched headless turn that ended, a terminal long closed —
 * has no status, not `idle`: nothing is watching it.
 */
export function statusOf(session: AgentSessionSummary, live: LiveSession | undefined, lastHook: number | undefined, at: number): AgentSessionSummary['status'] {
  if (live?.status === 'busy') return 'busy'
  if (lastHook !== undefined && at - lastHook < RECENT_HOOK_MS) return 'busy'
  if (live) return 'idle'
  // Codex's `active` is its server's word for a thread with a turn in flight.
  if (session.provider === 'codex' && session.active) return 'busy'
  return undefined
}

const key = (ref: { provider: string; sessionId: string }): string => `${ref.provider}:${ref.sessionId}`

interface Deps {
  agents: AgentRegistry
  presence: PresenceService
  live?: () => Promise<LiveSession[]>
}

export function createSessionLister({ agents, presence, live = liveSessions }: Deps): SessionLister {
  return {
    async list(worktree, limit) {
      const own = await agents.listWorktreeSessions(worktree.path, limit)
      const listed = new Set(own.map(key))
      const inside = (cwd: string): boolean => cwd === worktree.path || cwd.startsWith(`${worktree.path}/`)
      const visiting = presence.sessionsIn(worktree.id).filter((entry) => !listed.has(key(entry)) && !inside(entry.cwd))
      const registry = new Map((await live()).map((entry) => [entry.sessionId, entry]))

      const visitors = await Promise.all(
        visiting.map(async (entry): Promise<AgentSessionSummary> => {
          // The provider knows the title and the first prompt; the hooks know it was here. A
          // session the provider cannot find any more is still listed, by id, because it was.
          const known = await agents.adapterFor(entry.provider).describeSession?.(entry.sessionId, entry.cwd).catch(() => undefined)
          return {
            ...known,
            provider: entry.provider,
            sessionId: entry.sessionId,
            title: known?.title ?? entry.sessionId.slice(0, 8),
            cwd: known?.cwd ?? entry.cwd,
            updatedAt: Math.max(known?.updatedAt ?? 0, entry.lastAt),
            active: registry.has(entry.sessionId),
            visiting: true
          }
        })
      )

      const at = now()
      return [...own, ...visitors]
        .map((session) => {
          const status = statusOf(session, registry.get(session.sessionId), presence.lastSeen(session.provider, session.sessionId), at)
          return status ? { ...session, status } : session
        })
        .sort((a, b) => b.updatedAt - a.updatedAt)
    }
  }
}
