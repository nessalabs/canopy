import type { FastifyInstance } from 'fastify'

import { AgentProvider, NewSessionInput, SendMessageInput, SessionRef, routes } from '@canopy/shared'

import { ClaudeHookPayload } from '../agents/edit-diffs/hook'

import { streamSse } from '../lib/sse'
import { now } from '../lib/ids'
import type { Services } from './context'
import { CwdQuery, IdParams, LimitQuery, SessionParams } from './params'

export function registerAgentRoutes(app: FastifyInstance, { agents, worktrees, review, editDiffs }: Services): void {
  app.get(routes.providers(), async () => ({ providers: await agents.availableProviders() }))

  app.get(routes.agentSessions(':id'), async (request) => {
    const worktree = await worktrees.get(IdParams.parse(request.params).id)
    const { limit } = LimitQuery.parse(request.query)
    return { sessions: await agents.listWorktreeSessions(worktree.path, limit), pinned: review.pinned(worktree.id) }
  })

  app.post(routes.agentSessions(':id'), async (request, reply) => {
    const worktree = await worktrees.get(IdParams.parse(request.params).id)
    const { provider, text, ...options } = NewSessionInput.parse(request.body)
    const adapter = agents.adapterFor(provider)
    await streamSse(request, reply, (signal) => adapter.send(null, text, { ...options, cwd: worktree.path, signal }))
  })

  app.put(routes.agentPin(':id'), async (request, reply) => {
    review.pin(IdParams.parse(request.params).id, SessionRef.parse(request.body), now())
    return reply.code(204).send()
  })

  app.get(routes.transcript(':provider', ':sid'), async (request) => {
    const { provider, sid } = SessionParams.parse(request.params)
    return agents.adapterFor(provider).transcript(sid, CwdQuery.parse(request.query).cwd)
  })

  app.get(routes.agentEdits(':provider', ':sid'), async (request) => {
    const { provider, sid } = SessionParams.parse(request.params)
    return { edits: editDiffs.list(AgentProvider.parse(provider), sid) }
  })

  // Hook commands must never stall the agent: validation errors are the hook's problem, not Claude's.
  app.post(routes.hooksClaude(), async (request, reply) => {
    await editDiffs.onClaudeHook(ClaudeHookPayload.parse(request.body))
    return reply.code(204).send()
  })

  app.post(routes.messages(':provider', ':sid'), async (request, reply) => {
    const { provider, sid } = SessionParams.parse(request.params)
    const { text, ...options } = SendMessageInput.parse(request.body)
    const adapter = agents.adapterFor(provider)
    await streamSse(request, reply, (signal) => adapter.send(sid, text, { ...options, signal }))
  })
}
