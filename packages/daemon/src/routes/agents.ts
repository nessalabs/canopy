import { resolve } from 'node:path'

import type { FastifyInstance } from 'fastify'

import { AgentProvider, CapabilitiesQuery, LiveControlsInput, NewSessionInput, PermissionDecisionInput, QueueMessageInput, RewindInput, SendMessageInput, SessionRef, routes } from '@canopy/shared'

import { ClaudeHookPayload } from '../agents/edit-diffs/hook'

import { ApiError } from '../lib/errors'
import { streamSse } from '../lib/sse'
import { now } from '../lib/ids'
import type { Services } from './context'
import { CwdQuery, IdParams, LimitQuery, SessionParams } from './params'

export function registerAgentRoutes(app: FastifyInstance, { agents, worktrees, review, editDiffs, presence, sessions }: Services): void {
  app.get(routes.providers(), async () => ({ providers: await agents.availableProviders() }))

  app.get(routes.agentSessions(':id'), async (request) => {
    const worktree = await worktrees.get(IdParams.parse(request.params).id)
    const { limit } = LimitQuery.parse(request.query)
    return { sessions: await sessions.list(worktree, limit), pinned: review.pinned(worktree.id) }
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
    const payload = ClaudeHookPayload.parse(request.body)
    // Presence is advisory; the snapshot pair is not. A failed row (a locked database, a worktree
    // deleted under the hook) must not cost the call its before-snapshot.
    try {
      presence.record(payload)
    } catch (err) {
      request.log.warn({ err }, 'session presence not recorded')
    }
    await editDiffs.onClaudeHook(payload)
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

  /**
   * Undoing what a turn wrote. The body picks the mechanism: a `tree` is one of Canopy's own
   * pre-turn snapshots and restores the whole checkout, shell side effects included; without one
   * the provider's checkpoints are used, which cover only what its file tools wrote.
   *
   * Neither needs a live turn, and "no, because…" is a 200: a message the provider has no
   * checkpoint for is an answer the client renders, not a broken request. The failures that *are*
   * errors are structural — a cwd this daemon does not manage, a provider that cannot rewind at all.
   */
  app.post(routes.rewind(':provider', ':sid'), async (request) => {
    const { provider, sid } = SessionParams.parse(request.params)
    const input = RewindInput.parse(request.body)
    // Writing into a directory Canopy knows nothing about is not a rewind, it is an arbitrary
    // file write driven by a request body — so the cwd is checked the way the hook receiver does,
    // and in canonical form: `<worktree>/../elsewhere` is outside, whatever it starts with. The
    // canonical path is what goes onward, so what was checked is what gets used.
    const cwd = resolve(input.cwd)
    const worktree = worktrees.containing(cwd)
    if (!worktree) throw new ApiError(400, 'unknown_worktree', `${input.cwd} is not inside a worktree Canopy manages`)
    // A snapshot is of the whole checkout, so it is restored at the checkout's root whatever
    // subdirectory the session happened to run in; the provider's own rewind keeps the caller's
    // cwd, because that is what its `filesChanged` are reported relative to.
    if (input.tree) return editDiffs.restore(worktree.path, input.tree, input.dryRun)

    const adapter = agents.adapterFor(provider)
    if (!adapter.rewind) throw new ApiError(404, 'unsupported', `the ${provider} agent cannot rewind files`)
    return adapter.rewind(sid, { ...input, cwd })
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
