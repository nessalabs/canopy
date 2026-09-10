import type { CanUseTool, SDKMessage } from '@anthropic-ai/claude-agent-sdk'

import type { AgentAdapter, AgentSessionSummary, AgentStreamEvent, SendOptions, TranscriptResponse } from './types'
import type { AgentEvent } from '@canopy/shared/agent-stream'
import type { PermissionDecisionInput } from '@canopy/shared'
import { ClaudeStreamMapper } from '@canopy/shared/agent-stream'

import { newId } from '../lib/ids'
import { mapClaudeMessage } from './claude-map'
import type { WireMessage } from './claude-normalize'
import { readSessionExtras, type QueuedPrompt } from './claude-session'
import { liveSessionFor, liveSessions } from './claude-terminal'
import { slim } from './events'
import { toImageBlocks } from './images'
import { createPermissionDesk, type PermissionDesk } from './permissions'

/**
 * Claude Code adapter, built on `@anthropic-ai/claude-agent-sdk`.
 *
 * The SDK exposes the same session store the terminal's `/resume` picker reads
 * (`~/.claude/projects/<munged-cwd>/<sessionId>.jsonl`), so listing and replay
 * are first-class calls rather than file scraping:
 *   listSessions({ dir })      — sessions for a checkout *and its worktrees*
 *   getSessionMessages(id)     — the stored transcript
 *   query({ options.resume })  — append a turn to that same session
 *
 * The SDK's `stream-json` messages are the same frames nessa's agent-stream parser was captured
 * from, so both replay and live turns feed one `ClaudeStreamMapper` and the daemon ships the
 * normalized `AgentEvent`s the UI folds.
 *
 * The SDK is loaded lazily so Canopy still boots (Codex-only) when it isn't installed.
 */

export type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk')

let sdkPromise: Promise<SdkModule | undefined> | undefined

async function sdk(): Promise<SdkModule | undefined> {
  sdkPromise ??= import('@anthropic-ai/claude-agent-sdk').catch(() => undefined)
  return sdkPromise
}

const PERMISSION_MODE = {
  'read-only': 'plan',
  edit: 'acceptEdits',
  full: 'bypassPermissions'
} as const

export interface ClaudeAdapterOptions {
  /** Shared with the route that answers prompts; one desk per daemon by default. */
  desk?: PermissionDesk
  /** Swapped in tests for a scripted `query`; production loads the real SDK lazily. */
  loadSdk?: () => Promise<SdkModule | undefined>
}

/** A queued mid-turn prompt as the wire `user` line the mapper reads (the SDK's replay drops these). */
const queuedLine = (parentSessionId: string, queued: QueuedPrompt): WireMessage => ({
  type: 'user',
  uuid: queued.uuid,
  session_id: parentSessionId,
  parent_tool_use_id: null,
  message: { role: 'user', content: queued.prompt }
})

/** Fires when any of its inputs does, so one ask can be cancelled by the tool call or by the turn. */
function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController()
  for (const signal of signals) {
    if (!signal) continue
    if (signal.aborted) {
      controller.abort()
      break
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  return controller.signal
}

export class ClaudeAdapter implements AgentAdapter {
  readonly provider = 'claude' as const
  /** Where live turns park their permission prompts until a client answers one. */
  readonly permissions: PermissionDesk
  private readonly loadSdk: () => Promise<SdkModule | undefined>

  constructor(options: ClaudeAdapterOptions = {}) {
    this.permissions = options.desk ?? createPermissionDesk()
    this.loadSdk = options.loadSdk ?? sdk
  }

  answerPermission(sessionId: string, input: PermissionDecisionInput): boolean {
    return this.permissions.answer(sessionId, input)
  }

  async available(): Promise<boolean> {
    return (await this.loadSdk()) !== undefined
  }

  async listSessions(cwd: string, limit = 25): Promise<AgentSessionSummary[]> {
    const module = await this.loadSdk()
    if (!module) return []
    const sessions = await module.listSessions({
      dir: cwd,
      limit,
      // Worktrees get their own project key, so a worktree path lists only its
      // own sessions — which is exactly the attribution Canopy wants.
      includeWorktrees: false,
      // Canopy launches its worktree agents headless, so SDK/daemon sessions are
      // the common case here — unlike a terminal `/resume` picker, which hides them.
      includeProgrammatic: true
    })
    const live = new Set((await liveSessions()).map((entry) => entry.sessionId))
    return sessions.map((session) => ({
      provider: this.provider,
      sessionId: session.sessionId,
      title: session.customTitle ?? session.summary ?? session.sessionId.slice(0, 8),
      cwd: session.cwd,
      gitBranch: session.gitBranch,
      createdAt: session.createdAt,
      updatedAt: session.lastModified,
      preview: session.firstPrompt,
      active: live.has(session.sessionId)
    }))
  }

  async transcript(sessionId: string, cwd?: string): Promise<TranscriptResponse> {
    const module = await this.loadSdk()
    if (!module) return { events: [], files: {}, extras: {}, nextSeq: 0 }
    const [messages, sessionExtras, live] = await Promise.all([
      module.getSessionMessages(sessionId, cwd ? { dir: cwd } : undefined),
      readSessionExtras(cwd, sessionId),
      liveSessionFor(sessionId)
    ])

    const mapper = new ClaudeStreamMapper()
    const events: AgentEvent[] = []
    const files: Record<string, string[]> = {}
    const imageExtras: Record<string, { images: import('@canopy/shared').TurnImage[] }> = {}
    let model: string | undefined

    const feed = (message: WireMessage): void => {
      const mapped = mapClaudeMessage(mapper, message, cwd)
      for (const event of mapped.events) events.push(slim(event))
      Object.assign(files, mapped.files)
      Object.assign(imageExtras, mapped.extras)
    }

    for (const message of messages) {
      const payload = message.message as { role?: string; content?: unknown; model?: string } | undefined
      if (!payload?.role) continue
      if (payload.role === 'assistant' && payload.model && !payload.model.startsWith('<')) model = payload.model
      feed(message as unknown as WireMessage)
      // Prompts typed mid-turn are stored as attachments the SDK drops; re-inject them in place.
      for (const queued of sessionExtras.queued.filter((q) => q.parentUuid === message.uuid)) feed(queuedLine(sessionId, queued))
    }

    return {
      events,
      files,
      extras: imageExtras,
      model,
      effort: sessionExtras.effort,
      openInTerminal: live !== undefined,
      nextSeq: (events.at(-1)?.seq ?? -1) + 1
    }
  }

  async *send(sessionId: string | null, text: string, options: SendOptions = {}): AsyncIterable<AgentStreamEvent> {
    const module = await this.loadSdk()
    if (!module) {
      yield { type: 'error', message: '@anthropic-ai/claude-agent-sdk is not installed' }
      return
    }
    let resolvedSession = sessionId ?? ''
    // A fresh session's id is only known once the SDK's init message arrives (below); a resume
    // already knows it. Either way the envelope is announced exactly once.
    let announced = sessionId !== null
    if (sessionId) yield { type: 'session', provider: this.provider, sessionId }

    // Images ride along as content blocks, which needs the structured prompt form.
    const prompt = options.images?.length
      ? (async function* () {
          yield {
            type: 'user' as const,
            message: { role: 'user' as const, content: [{ type: 'text' as const, text }, ...toImageBlocks(options.images ?? [])] },
            parent_tool_use_id: null
          }
        })()
      : text

    // Numbering continues from the transcript the client already holds, so a live turn's events
    // extend that log instead of colliding with it.
    const mapper = new ClaudeStreamMapper({ startSeq: options.startSeq ?? 0 })

    // Frames raised outside the SDK's message loop land here; the loop below drains them. The
    // permission callback is the reason: it runs while the SDK is parked waiting on our answer,
    // so its frames have to reach the client without a message arriving to carry them.
    const queue: AgentStreamEvent[] = []
    let notify: (() => void) | undefined
    const push = (event: AgentStreamEvent): void => {
      queue.push(event)
      notify?.()
    }
    /** Maps one wire line with the turn's mapper and queues everything it produced. */
    const feed = (line: WireMessage): void => {
      const mapped = mapClaudeMessage(mapper, line, options.cwd)
      for (const [callId, files] of Object.entries(mapped.files)) push({ type: 'files', callId, files })
      for (const event of mapped.events) push({ type: 'event', event: slim(event) })
    }

    /**
     * The SDK never echoes the prompt back — its `user` lines are tool results — so a live turn
     * would carry no `user_message` and the UI would fold the work onto the *previous* turn,
     * drawing the prompt below the reply it asked for. Feeding the line the CLI would have written
     * opens the turn at the head of the stream, with the seq the rest of it continues from.
     */
    const echoPrompt = (): void => {
      feed({
        type: 'user',
        uuid: newId(),
        session_id: resolvedSession,
        parent_tool_use_id: null,
        message: {
          role: 'user',
          // Array content when images ride along, so the mapper's normalizer lifts them out of the
          // text the same way replay does.
          content: options.images?.length ? [{ type: 'text', text }, ...toImageBlocks(options.images)] : text
        }
      })
    }
    // A resume already knows its session; a new one echoes as soon as `init` names it (below).
    if (sessionId) echoPrompt()

    const permissionMode = PERMISSION_MODE[options.autonomy ?? 'edit']
    const desk = this.permissions

    /**
     * Every tool the chosen mode would have prompted for — Bash, WebFetch, an MCP call — arrives
     * here. Without a handler the SDK denies them all and the turn degrades in silence, so instead
     * the ask is published as the `permission_requested` event the UI already renders and parked
     * until someone POSTs an answer. The synthetic wire lines go through the turn's own mapper so
     * the ask and its answer carry the next `seq` and the same session id as the rest of the log.
     */
    const canUseTool: CanUseTool = async (toolName, input, context) => {
      const requestId = context.toolUseID || newId()
      const signal = anySignal([context.signal, options.signal])
      feed({
        type: 'control_request',
        request_id: requestId,
        ...(resolvedSession ? { session_id: resolvedSession } : {}),
        request: {
          subtype: 'can_use_tool',
          tool_name: toolName,
          tool_use_id: context.toolUseID,
          input,
          description: context.description,
          display_name: context.displayName,
          decision_reason_type: context.decisionReason
        }
      })

      const decision = await desk.ask(resolvedSession, requestId, signal)
      // An unattended daemon must still tell the model *why* it was refused, so it can try
      // something else instead of retrying the same call forever.
      const denial =
        decision.message ??
        (signal.aborted ? `Canopy: the turn was cancelled before this ${toolName} call was answered` : `Canopy: the user declined this ${toolName} call`)
      const allowed = decision.behavior === 'allow'
      feed({
        type: 'control_response',
        ...(resolvedSession ? { session_id: resolvedSession } : {}),
        response: { request_id: requestId, response: allowed ? { behavior: 'allow' } : { behavior: 'deny', message: denial } }
      })
      return allowed ? { behavior: 'allow', updatedInput: decision.updatedInput ?? input } : { behavior: 'deny', message: denial }
    }

    const response = module.query({
      prompt,
      options: {
        // Continues the very session that produced the diff — same history, same CLAUDE.md, same
        // tool state — unless the caller asked for a new one. When a terminal has this session open
        // the turn still runs here; that terminal won't show it until it resumes.
        ...(sessionId ? { resume: sessionId } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
        permissionMode,
        // The SDK refuses `bypassPermissions` unless the host says out loud that it means it; every
        // other mode keeps its prompts and routes them to a human through `canUseTool`.
        ...(permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : { canUseTool }),
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        includePartialMessages: true,
        ...(options.signal ? { abortController: abortControllerFor(options.signal) } : {})
      }
    })

    // The API reports output tokens cumulatively per message; the turn total is the finished
    // messages plus the one in flight. The mapper drops `message_delta.usage`, so this stays.
    let finishedTokens = 0
    let currentTokens = 0
    let ended = false

    const consume = (message: SDKMessage): void => {
      if (message.type === 'system' && 'session_id' in message) {
        resolvedSession = message.session_id
        if (!announced) {
          push({ type: 'session', provider: this.provider, sessionId: resolvedSession })
          announced = true
          echoPrompt()
        }
      }
      if (message.type === 'stream_event') {
        const event = message.event as { type?: string; usage?: { output_tokens?: number } }
        if (event.type === 'message_start') {
          finishedTokens += currentTokens
          currentTokens = 0
        }
        if (event.type === 'message_delta' && typeof event.usage?.output_tokens === 'number') {
          currentTokens = event.usage.output_tokens
          push({ type: 'progress', tokens: finishedTokens + currentTokens })
        }
      }

      feed(message as unknown as WireMessage)

      if (message.type === 'result') {
        // `errors` names what actually went wrong; the subtype alone says only that something did.
        if (message.subtype !== 'success') {
          const errors = 'errors' in message && Array.isArray(message.errors) ? message.errors : []
          push({ type: 'error', message: errors.length > 0 ? `claude: ${message.subtype}: ${errors.join('; ')}` : `claude: ${message.subtype}` })
        }
        ended = true
      }
    }

    const iterator = response[Symbol.asyncIterator]()
    let next: Promise<IteratorResult<SDKMessage, void>> | undefined
    try {
      while (!ended) {
        if (queue.length > 0) {
          yield queue.shift() as AgentStreamEvent
          continue
        }
        // Waiting on the SDK alone would deadlock a prompt: the message that would flush the ask
        // is the one the SDK is refusing to produce until the ask is answered. Racing the queue's
        // notifier lets a frame raised inside `canUseTool` go out while the SDK is still parked.
        // Armed *before* the iterator is touched, because `next()` runs the callback synchronously
        // up to its first await — the ask is already queued by the time `next()` returns.
        const woken = new Promise<void>((resolve) => (notify = resolve)).then(() => undefined)
        next ??= iterator.next()
        const arrived = await Promise.race([next, woken])
        notify = undefined
        if (arrived === undefined) continue
        next = undefined
        if (arrived.done) break
        consume(arrived.value)
      }
      while (queue.length > 0) yield queue.shift() as AgentStreamEvent
      yield { type: 'done', sessionId: resolvedSession }
    } finally {
      // Closes the SDK's query the way falling out of a `for await` used to.
      void iterator.return?.()?.catch?.(() => undefined)
    }
  }
}

/** The SDK takes an AbortController; the HTTP layer hands us its signal. */
function abortControllerFor(signal: AbortSignal): AbortController {
  const controller = new AbortController()
  if (signal.aborted) controller.abort()
  else signal.addEventListener('abort', () => controller.abort(), { once: true })
  return controller
}
