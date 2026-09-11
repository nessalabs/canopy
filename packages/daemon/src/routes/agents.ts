import type { FastifyInstance } from 'fastify'

import { AgentProvider, CapabilitiesQuery, LiveControlsInput, NewSessionInput, PermissionDecisionInput, QueueMessageInput, SendMessageInput, SessionRef, routes } from '@canopy/shared'

import { ClaudeHookPayload } from '../agents/edit-diffs/hook'

import { ApiError } from '../lib/errors'
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

  // The answer to a `permission_requested` event arrives on its own request, not on the turn's
  // stream: the turn is parked inside the adapter waiting for exactly this. Nothing pending under
  // the id means the turn already ended (or answered) — the client's view is stale, not malformed.
  app.post(routes.permissions(':provider', ':sid'), async (request, reply) => {
    const { provider, sid } = SessionParams.parse(request.params)
    const input = PermissionDecisionInput.parse(request.body)
    const answered = agents.adapterFor(provider).answerPermission?.(sid, input) === true
    if (!answered) throw new ApiError(404, 'unknown_permission_request', `no permission request ${input.requestId} is pending on ${provider} session ${sid}`)
    return reply.code(204).send()
  })

  // Read lazily and cached by the adapter: the first caller pays for the provider's probe, and a
  // daemon that nobody asks never starts one at all.
  app.get(routes.agentCapabilities(':id'), async (request) => {
    const worktree = await worktrees.get(IdParams.parse(request.params).id)
    const { provider, session, refresh } = CapabilitiesQuery.parse(request.query)
    const adapter = agents.adapterFor(provider)
    if (!adapter.capabilities) throw new ApiError(404, 'unsupported', `the ${provider} agent does not advertise capabilities`)
    return adapter.capabilities(worktree.path, { sessionId: session, refresh })
  })

  /**
   * Steering a turn that is already running. All three answer 404 `no_live_turn` on the same
   * condition: this daemon has no turn open for that session — it ended, or it is being driven from
   * somewhere else — which is a stale view on the client's side, not a malformed request.
   */
  app.post(routes.interrupt(':provider', ':sid'), async (request, reply) => {
    const { provider, sid } = SessionParams.parse(request.params)
    const stopped = (await agents.adapterFor(provider).interrupt?.(sid)) === true
    if (!stopped) throw noLiveTurn(provider, sid)
    return reply.code(204).send()
  })

  app.post(routes.queue(':provider', ':sid'), async (request, reply) => {
    const { provider, sid } = SessionParams.parse(request.params)
    const { text, images } = QueueMessageInput.parse(request.body)
    if (agents.adapterFor(provider).queue?.(sid, text, images) !== true) throw noLiveTurn(provider, sid)
    return reply.code(204).send()
  })

  app.patch(routes.liveControls(':provider', ':sid'), async (request, reply) => {
    const { provider, sid } = SessionParams.parse(request.params)
    const input = LiveControlsInput.parse(request.body)
    const applied = (await agents.adapterFor(provider).control?.(sid, input)) === true
    if (!applied) throw noLiveTurn(provider, sid)
    return reply.code(204).send()
  })
}

const noLiveTurn = (provider: string, sid: string) => new ApiError(404, 'no_live_turn', `no turn is running in ${provider} session ${sid}`)
