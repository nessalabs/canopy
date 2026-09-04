import { badRequest } from '../lib/errors'
import { ClaudeAdapter } from './claude'
import { CodexAdapter } from './codex'
import type { AgentAdapter, AgentProvider, AgentSessionSummary } from './types'

export interface AgentRegistry {
  adapterFor(provider: string): AgentAdapter
  availableProviders(): Promise<AgentProvider[]>
  /**
   * Every agent session that ran in this worktree, newest first. Attribution is by
   * working directory: a Canopy worktree is its own checkout, so a session whose cwd
   * is that path worked on this branch. A provider that is missing or unauthenticated
   * contributes nothing rather than failing the listing.
   */
  listWorktreeSessions(cwd: string, limit?: number): Promise<AgentSessionSummary[]>
}

export const defaultAdapters = (): AgentAdapter[] => [new ClaudeAdapter(), new CodexAdapter()]

export function createAgentRegistry(adapters: AgentAdapter[] = defaultAdapters()): AgentRegistry {
  const byProvider = new Map(adapters.map((adapter) => [adapter.provider, adapter] as const))
  const swallow = async <T>(work: Promise<T>, fallback: T): Promise<T> => work.catch(() => fallback)

  return {
    adapterFor(provider) {
      const adapter = byProvider.get(provider as AgentProvider)
      if (!adapter) throw badRequest('unknown_provider', `unknown agent provider: ${provider}`)
      return adapter
    },

    async availableProviders() {
      const checks = await Promise.all(adapters.map(async (a) => ((await swallow(a.available(), false)) ? a.provider : null)))
      return checks.filter((p): p is AgentProvider => p !== null)
    },

    async listWorktreeSessions(cwd, limit = 25) {
      const lists = await Promise.all(adapters.map((a) => swallow(a.listSessions(cwd, limit), [] as AgentSessionSummary[])))
      return lists.flat().sort((a, b) => b.updatedAt - a.updatedAt)
    }
  }
}
