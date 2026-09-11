/**
 * The sessions a worktree's Agent tab lists: the ones that ran in its checkout, plus the ones
 * that worked here from another — a session started in the main checkout and told to work in
 * this worktree is this worktree's session too, whatever `~/.claude/projects` files it under.
 * Each carries what is known about whether it is still going.
 */
import type { AgentProvider, AgentSessionSummary } from '@canopy/shared'

import { now } from '../lib/ids'
import { liveSessions, type LiveSession } from './claude-terminal'
import type { PresenceService } from './presence'
import type { AgentRegistry } from './registry'

export interface SessionLister {
  list(worktree: { id: string; path: string }, limit?: number): Promise<AgentSessionSummary[]>
}

/** A hook this recent means a tool call is running or just finished: the turn is not over. */
export const RECENT_HOOK_MS = 60_000
/** What a provider said about a session is reread this often; titles and first prompts rarely move. */
export const DESCRIBE_TTL_MS = 30_000

/**
 * What a session is doing, from the two things that can know: its terminal's registry entry,
 * which says `busy` or `idle` outright, and its hooks, whose last report dates the last tool call.
 * The terminal's word wins where it has one — a turn that just ended is idle, however recent its
 * last hook; the hook window covers headless sessions and terminals that have not said. A session
 * with neither — a Canopy-launched headless turn that ended, a terminal long closed — has no
 * status, not `idle`: nothing is watching it.
 */
export function statusOf(session: AgentSessionSummary, live: LiveSession | undefined, lastHook: number | undefined, at: number): AgentSessionSummary['status'] {
  if (live?.status === 'busy') return 'busy'
  if (live?.status === 'idle') return 'idle'
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
  // The listing is polled; what a provider knows about a session by id is not worth a transcript
  // scan every few seconds, so it is kept per (session, cwd) for a while.
  const described = new Map<string, { at: number; value: Promise<AgentSessionSummary | undefined> }>()
  const describe = (entry: { provider: AgentProvider; sessionId: string; cwd: string }, at: number): Promise<AgentSessionSummary | undefined> => {
    const id = `${key(entry)}@${entry.cwd}`
    const hit = described.get(id)
    if (hit && at - hit.at < DESCRIBE_TTL_MS) return hit.value
    const value = (agents.adapterFor(entry.provider).describeSession?.(entry.sessionId, entry.cwd) ?? Promise.resolve(undefined)).catch(() => undefined)
    described.set(id, { at, value })
    return value
  }

  return {
    async list(worktree, limit) {
      const at = now()
      const own = await agents.listWorktreeSessions(worktree.path, limit)
      const listed = new Set(own.map(key))
      // The provider files a session under the exact directory it started in, so one started in a
      // subdirectory of this worktree is not in `own` — but it is this worktree's, not a visitor.
      const inside = (cwd: string): boolean => cwd === worktree.path || cwd.startsWith(`${worktree.path}/`)
      const unlisted = presence.sessionsIn(worktree.id).filter((entry) => !listed.has(key(entry)))
      const registry = new Map((await live()).map((entry) => [entry.sessionId, entry]))

      const fromHooks = await Promise.all(
        unlisted.map(async (entry): Promise<AgentSessionSummary> => {
          // The provider knows the title and the first prompt; the hooks know it was here. A
          // session the provider cannot find any more is still listed, by id, because it was.
          const known = await describe(entry, at)
          return {
            ...known,
            provider: entry.provider,
            sessionId: entry.sessionId,
            title: known?.title ?? entry.sessionId.slice(0, 8),
            cwd: known?.cwd ?? entry.cwd,
            updatedAt: Math.max(known?.updatedAt ?? 0, entry.lastAt),
            active: registry.has(entry.sessionId),
            ...(inside(entry.cwd) ? {} : { visiting: true })
          }
        })
      )

      const all = [...own, ...fromHooks]
        .map((session) => {
          const status = statusOf(session, registry.get(session.sessionId), presence.lastSeen(session.provider, session.sessionId), at)
          return status ? { ...session, status } : session
        })
        .sort((a, b) => b.updatedAt - a.updatedAt)
      return limit === undefined ? all : all.slice(0, limit)
    }
  }
}
