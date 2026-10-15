import type { FastifyInstance } from 'fastify'

import { SessionRef, routes } from '@canopy/shared'

import { titled } from '../git-agent/store'
import type { Services } from './context'
import { IdParams } from './params'

/** How far back the provider listing is read for titles: the most the session route allows. */
const TITLE_LOOKBACK = 200

/** What the Git Agent keeps per worktree: its past conversations. */
export function registerGitAgentRoutes(app: FastifyInstance, { gitAgent, sessions, worktrees }: Services): void {
  app.get(routes.gitAgentSessions(':id'), async (request) => {
    const worktree = await worktrees.get(IdParams.parse(request.params).id)
    return { sessions: titled(gitAgent.sessions(worktree.id), await sessions.list(worktree, TITLE_LOOKBACK)) }
  })

  app.post(routes.gitAgentSessions(':id'), async (request, reply) => {
    gitAgent.remember(IdParams.parse(request.params).id, SessionRef.parse(request.body))
    return reply.code(204).send()
  })
}
