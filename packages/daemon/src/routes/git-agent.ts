import type { FastifyInstance } from 'fastify'

import { GroupInput, GroupingPatch, SessionRef, routes } from '@canopy/shared'

import { titled } from '../git-agent/store'
import type { Services } from './context'
import { GroupingParams, IdParams } from './params'

/** How far back the provider listing is read for titles: the most the session route allows. */
const TITLE_LOOKBACK = 200

/** What the Git Agent keeps per worktree: its past conversations and the groupings of the change. */
export function registerGitAgentRoutes(app: FastifyInstance, { gitAgent, startGrouping, sessions, worktrees }: Services): void {
  app.get(routes.gitAgentSessions(':id'), async (request) => {
    const worktree = await worktrees.get(IdParams.parse(request.params).id)
    return { sessions: titled(gitAgent.sessions(worktree.id), await sessions.list(worktree, TITLE_LOOKBACK)) }
  })

  app.post(routes.gitAgentSessions(':id'), async (request, reply) => {
    gitAgent.remember(IdParams.parse(request.params).id, SessionRef.parse(request.body))
    return reply.code(204).send()
  })

  app.get(routes.groupings(':id'), async (request) => ({ groupings: gitAgent.groupings(IdParams.parse(request.params).id) }))

  app.post(routes.groupings(':id'), async (request, reply) => reply.code(201).send(await startGrouping(IdParams.parse(request.params).id, GroupInput.parse(request.body))))

  app.patch(routes.grouping(':id', ':gid'), async (request) => {
    const { id, gid } = GroupingParams.parse(request.params)
    return { grouping: gitAgent.updateGrouping(id, gid, GroupingPatch.parse(request.body)) }
  })

  app.delete(routes.grouping(':id', ':gid'), async (request, reply) => {
    const { id, gid } = GroupingParams.parse(request.params)
    gitAgent.removeGrouping(id, gid)
    return reply.code(204).send()
  })
}
