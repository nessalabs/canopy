/**
 * The sessions a worktree's Agent tab lists: the ones that ran in its checkout, plus the ones
 * that worked here from another — a session started in the main checkout and told to work in
 * this worktree is this worktree's session too, whatever `~/.claude/projects` files it under.
 * Each carries what is known about whether it is still going.
 *
 * After those come the project's other checkouts, marked with an `origin`: the main checkout
 * lists every worktree's sessions, removed worktrees included — deleting a worktree is routine,
 * and the conversation that built the branch should not go with it — and a worktree lists the
 * main checkout's, where a session about this branch was often started.
 */
import type { AgentProvider, AgentSessionSummary, Project } from '@canopy/shared'

import { now } from '../lib/ids'
import type { ProjectCheckouts } from './checkouts'
import { liveSessions, type LiveSession } from './claude-terminal'
import type { PresenceService } from './presence'
import type { AgentRegistry } from './registry'

export interface SessionLister {
  list(worktree: { id: string; path: string; isMain?: boolean; projectId?: string }, limit?: number): Promise<AgentSessionSummary[]>
}

/** A hook this recent means a tool call is running or just finished: the turn is not over. */
export const RECENT_HOOK_MS = 60_000
/** What a provider said about a session is reread this often; titles and first prompts rarely move. */
export const DESCRIBE_TTL_MS = 30_000
/** Sessions listed per other checkout: enough to find a conversation, not a full history. */
export const OTHER_CHECKOUT_LIMIT = 15
/**
 * How far back a worktree looks through the main checkout for sessions on its own branch, which
 * are listed however old they are among those: they are the conversations about this worktree.
 */
export const MAIN_BRANCH_LOOKBACK = 60

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
  /** Without these only the worktree's own sessions are listed. */
  checkouts?: ProjectCheckouts
  projects?: { get(id: string): Project }
}

export function createSessionLister({ agents, presence, live = liveSessions, checkouts, projects }: Deps): SessionLister {
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

  // Other checkouts' sessions are reread on the describe cadence rather than on every poll: each
  // checkout is a provider listing, and the main checkout of a busy project has many.
  const elsewhere = new Map<string, { at: number; value: Promise<AgentSessionSummary[]> }>()
  const fromOtherCheckouts = (worktree: { id: string; path: string; isMain?: boolean; projectId?: string }, at: number): Promise<AgentSessionSummary[]> => {
    if (!checkouts || !projects || !worktree.projectId) return Promise.resolve([])
    const hit = elsewhere.get(worktree.id)
    if (hit && at - hit.at < DESCRIBE_TTL_MS) return hit.value
    const projectId = worktree.projectId
    const value = (async () => {
      const project = projects.get(projectId)
      const all = await checkouts.list(project)
      const targets = all.filter((c) => c.path !== worktree.path && (worktree.isMain ? true : c.kind === 'main'))
      const branch = worktree.isMain ? undefined : all.find((c) => c.worktreeId === worktree.id)?.branch
      const sessionsOf = async (path: string): Promise<AgentSessionSummary[]> => {
        if (!branch) return agents.listWorktreeSessions(path, OTHER_CHECKOUT_LIMIT)
        const found = await agents.listWorktreeSessions(path, MAIN_BRANCH_LOOKBACK)
        return found.filter((session, index) => index < OTHER_CHECKOUT_LIMIT || session.gitBranch === branch)
      }
      const lists = await Promise.all(
        targets.map(async (checkout) =>
          (await sessionsOf(checkout.path)).map((session): AgentSessionSummary => {
            // A subdirectory of this very checkout is not another checkout; its sessions are ours.
            if (checkout.worktreeId === worktree.id) return session
            return {
              ...session,
              origin: {
                kind: checkout.kind,
                name: checkout.name,
                path: checkout.path,
                branch: checkout.branch ?? session.gitBranch ?? null,
                ...(checkout.worktreeId ? { worktreeId: checkout.worktreeId } : {}),
                // A removed worktree's session carries on in the main checkout: the provider finds
                // it by id wherever it is resumed (it keeps writing to its own transcript).
                runIn: checkout.kind === 'removed' ? project.path : (session.cwd ?? checkout.path)
              }
            }
          })
        )
      )
      return lists.flat()
    })().catch(() => [])
    elsewhere.set(worktree.id, { at, value })
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

      const withStatus = (session: AgentSessionSummary): AgentSessionSummary => {
        const status = statusOf(session, registry.get(session.sessionId), presence.lastSeen(session.provider, session.sessionId), at)
        return status ? { ...session, status } : session
      }
      const all = [...own, ...fromHooks].map(withStatus).sort((a, b) => b.updatedAt - a.updatedAt)
      const mine = limit === undefined ? all : all.slice(0, limit)

      // Listed once: a session already here (its own, or visiting) keeps that place.
      const seen = new Set(all.map(key))
      const others = (await fromOtherCheckouts(worktree, at))
        .filter((session) => {
          if (seen.has(key(session))) return false
          seen.add(key(session))
          return true
        })
        .map(withStatus)
        .sort((a, b) => b.updatedAt - a.updatedAt)
      return [...mine, ...others]
    }
  }
}
