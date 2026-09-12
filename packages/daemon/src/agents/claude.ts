import type { CanUseTool, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

import type { AgentAdapter, AgentCapabilities, AgentSessionSummary, AgentStreamEvent, SendOptions, TranscriptResponse } from './types'
import type { AgentEvent } from '@canopy/shared/agent-stream'
import type { LiveControlsInput, PermissionDecisionInput, RewindInput, RewindResult, TurnImage } from '@canopy/shared'
import { ClaudeStreamMapper } from '@canopy/shared/agent-stream'

import { newId } from '../lib/ids'
import { ClaudeCapabilities, type InitAdvertisement } from './claude-capabilities'
import { createLiveTurn, LiveTurns, PromptChannel, type LiveQuery } from './claude-live'
import { mapClaudeMessage, usageFrom } from './claude-map'
import { rewindClaudeFiles } from './claude-rewind'
import type { WireMessage } from './claude-normalize'
import { readSessionExtras, type LocalCommandOutput, type QueuedPrompt } from './claude-session'
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

/** What a local slash command printed, as the `local_command` system line the mapper turns into assistant text. */
const localOutputLine = (parentSessionId: string, output: LocalCommandOutput): WireMessage => ({
  type: 'system',
  subtype: 'local_command',
  uuid: output.uuid,
  session_id: parentSessionId,
  content: `<local-command-stdout>${output.text}</local-command-stdout>`
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
  /** The turns running right now, by session id — what interrupt/queue/controls steer. */
  readonly live = new LiveTurns()
  private readonly loadSdk: () => Promise<SdkModule | undefined>
  private readonly capabilityCache: ClaudeCapabilities

  constructor(options: ClaudeAdapterOptions = {}) {
    this.permissions = options.desk ?? createPermissionDesk()
    this.loadSdk = options.loadSdk ?? sdk
    this.capabilityCache = new ClaudeCapabilities(this.loadSdk)
  }

  answerPermission(sessionId: string, input: PermissionDecisionInput): boolean {
    return this.permissions.answer(sessionId, input)
  }

  capabilities(cwd: string, opts: { sessionId?: string; refresh?: boolean } = {}): Promise<AgentCapabilities> {
    return this.capabilityCache.read(cwd, opts)
  }

  async interrupt(sessionId: string): Promise<boolean> {
    const turn = this.live.get(sessionId)
    if (!turn) return false
    await turn.interrupt()
    return true
  }

  queue(sessionId: string, text: string, images?: Array<Omit<TurnImage, 'label'>>): boolean {
    const turn = this.live.get(sessionId)
    if (!turn) return false
    // The uuid travels with the message: the CLI stores the one it is given, so this is also the
    // id its checkpoint for the queued prompt is filed under, and the id the echo reports.
    turn.push(userMessage(text, images, sessionId, newId()))
    return true
  }

  /**
   * Puts the checkout back to how it was before a turn wrote anything, by the CLI's own
   * checkpoints. A turn still running is asked directly; otherwise a resumed query is started just
   * to ask — the checkpoints live in the session file, so an ended session can still answer.
   *
   * "No, and here is why" is an answer, not a failure: a message the CLI has no checkpoint for
   * comes back as `canRewind: false` with the reason, which is what the client shows.
   */
  async rewind(sessionId: string, input: RewindInput): Promise<RewindResult> {
    const module = await this.loadSdk()
    if (!module) return { source: 'checkpoint', canRewind: false, error: '@anthropic-ai/claude-agent-sdk is not installed', filesChanged: [] }
    return rewindClaudeFiles(module, this.live.get(sessionId), sessionId, input)
  }

  async control(sessionId: string, input: LiveControlsInput): Promise<boolean> {
    const turn = this.live.get(sessionId)
    if (!turn) return false
    if (input.model) await turn.setModel(input.model)
    if (input.autonomy) await turn.setPermissionMode(PERMISSION_MODE[input.autonomy])
    return true
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
    return sessions.map((session) => ({ ...this.summarize(session), active: live.has(session.sessionId) }))
  }

  async describeSession(sessionId: string, cwd: string): Promise<AgentSessionSummary | undefined> {
    const module = await this.loadSdk()
    if (!module) return undefined
    const session = await module.getSessionInfo(sessionId, { dir: cwd })
    return session ? this.summarize(session) : undefined
  }

  private summarize(session: Awaited<ReturnType<SdkModule['listSessions']>>[number]): AgentSessionSummary {
    return {
      provider: this.provider,
      sessionId: session.sessionId,
      title: session.customTitle ?? session.summary ?? session.sessionId.slice(0, 8),
      cwd: session.cwd,
      gitBranch: session.gitBranch,
      createdAt: session.createdAt,
      updatedAt: session.lastModified,
      preview: session.firstPrompt
    }
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
    const extras: Record<string, import('@canopy/shared').TurnExtras> = {}
    let model: string | undefined

    const feed = (message: WireMessage): void => {
      const mapped = mapClaudeMessage(mapper, message, cwd)
      for (const event of mapped.events) events.push(slim(event))
      Object.assign(files, mapped.files)
      // Merged rather than replaced: one event can carry both its images and its message id.
      for (const [id, extra] of Object.entries(mapped.extras)) extras[id] = { ...extras[id], ...extra }
    }

    for (const message of messages) {
      const payload = message.message as { role?: string; content?: unknown; model?: string } | undefined
      if (!payload?.role) continue
      if (payload.role === 'assistant' && payload.model && !payload.model.startsWith('<')) model = payload.model
      feed(message as unknown as WireMessage)
      // Prompts typed mid-turn are stored as attachments the SDK drops; re-inject them in place.
      for (const queued of sessionExtras.queued.filter((q) => q.parentUuid === message.uuid)) feed(queuedLine(sessionId, queued))
      // What a local slash command answered is a system row the SDK drops too; it follows its prompt.
      for (const output of sessionExtras.localOutputs.filter((o) => o.parentUuid === message.uuid)) feed(localOutputLine(sessionId, output))
    }

    return {
      events,
      files,
      extras,
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

    /**
     * Every turn runs in streaming-input mode, even a one-shot: it is the only mode with a control
     * channel, so it is what makes Stop, "type while it works" and a mid-turn model switch possible
     * at all. The channel yields this first message and then whatever `queue()` pushes, and closes
     * when the turn ends — the SDK holds the CLI open until it does.
     */
    const channel = new PromptChannel()
    /**
     * The daemon picks the prompt's uuid rather than reading one back: the CLI stores the uuid it
     * is handed, so this one id is at once what the session file will hold, what the CLI files its
     * file checkpoint under, and what the echo below reports — which is what makes a rewind of
     * this turn addressable the moment it starts, without waiting for the session file to land.
     */
    const promptUuid = newId()
    const prompt = channel.stream(userMessage(text, options.images, resolvedSession, promptUuid))

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
      // Follows its own event, so a client can only learn a message id for a turn it already has.
      for (const [eventId, extra] of Object.entries(mapped.extras)) {
        if (extra.messageId) push({ type: 'message_id', eventId, messageId: extra.messageId })
      }
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
        // The same uuid the SDK was handed, so the id the client learns here is the one the CLI
        // stored — a rewind addressed by it names this turn and not some line that looks like it.
        uuid: promptUuid,
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
        // Every turn checkpoints what its file tools write, so "undo this turn" is answerable
        // later — from this query while it runs, and from a resumed one once it has ended.
        enableFileCheckpointing: true,
        includePartialMessages: true,
        ...(options.signal ? { abortController: abortControllerFor(options.signal) } : {})
      }
    })

    /**
     * The turn is addressable from here on. A resumed turn is keyed by its session id at once; a
     * fresh one has no id yet, so it parks under a throwaway key and re-keys when `init` names it —
     * the same moment the client learns that id from the `session` frame, so nothing can ask for a
     * key that does not exist yet.
     *
     * A prompt pushed mid-turn is echoed into the stream for the same reason the opening one is:
     * the SDK never sends it back, and replay (which reads it from the session file) would show a
     * prompt the live view never did.
     */
    let liveKey = sessionId ?? `pending:${newId()}`
    const turn = createLiveTurn(response as unknown as LiveQuery, channel, {
      // The uuid `queue()` minted rides on the message; echoing it keeps the client's id for the
      // queued prompt the same one the CLI stored for it.
      onPush: (message) => feed({ ...(message as unknown as WireMessage), uuid: message.uuid ?? newId(), session_id: resolvedSession })
    })
    this.live.register(liveKey, turn)

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
        this.live.rekey(liveKey, resolvedSession)
        liveKey = resolvedSession
      }
      // Only a turn advertises what the session can do — the capability probe never sees an `init`
      // — so every turn's is folded into the cache for its checkout.
      if (message.type === 'system' && message.subtype === 'init') this.capabilityCache.observeInit(options.cwd, message as unknown as InitAdvertisement)
      if (message.type === 'system' && message.subtype === 'commands_changed') this.capabilityCache.observeCommands(options.cwd, message.commands)
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
        /**
         * One result per turn — but a prompt pushed by `queue()` too late to fold into the running
         * turn runs as its own, and the CLI says so on the result it is about to follow. Ending the
         * stream here would drop that turn on the floor with nobody watching it; anything else (an
         * absent field, an older CLI) ends the stream exactly as it always did.
         */
        ended = (message.queued_turn_count ?? 0) === 0
        // What the turn cost, while the numbers are still in hand — ahead of `done`, so a client
        // that stops listening at `done` has already seen it. The figures are cumulative, so it is
        // the last result that has them all.
        const usage = ended ? usageFrom(message) : undefined
        if (usage) push(usage)
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
      this.live.release(liveKey, turn)
      // A streaming-input query stays open while its prompt stream might still produce a message,
      // so the channel has to be closed or the CLI behind it never exits.
      channel.close()
      // Closes the SDK's query the way falling out of a `for await` used to.
      void iterator.return?.()?.catch?.(() => undefined)
    }
  }
}

/**
 * One prompt as the SDK's streaming input wants it. Images ride along as content blocks, which is
 * the only form that carries them; plain text stays a string so the mapper reads it as the prompt
 * it is rather than as the CLI feeding the model back.
 *
 * `uuid` is not decoration: the CLI writes the message under the uuid it was given, so choosing it
 * here is what lets the daemon tell a client the id of a prompt it has only just sent.
 */
function userMessage(text: string, images: Array<Omit<TurnImage, 'label'>> | undefined, sessionId: string, uuid: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: images?.length ? [{ type: 'text', text }, ...toImageBlocks(images)] : text },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: uuid as SDKUserMessage['uuid']
  }
}

/** The SDK takes an AbortController; the HTTP layer hands us its signal. */
function abortControllerFor(signal: AbortSignal): AbortController {
  const controller = new AbortController()
  if (signal.aborted) controller.abort()
  else signal.addEventListener('abort', () => controller.abort(), { once: true })
  return controller
}
