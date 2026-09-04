import type { AgentAdapter, AgentSessionSummary, AgentStreamEvent, SendOptions, TranscriptResponse } from './types'
import type { AgentEvent } from '@canopy/shared/agent-stream'
import { ClaudeStreamMapper } from '@canopy/shared/agent-stream'

import { mapClaudeMessage } from './claude-map'
import type { WireMessage } from './claude-normalize'
import { readSessionExtras, type QueuedPrompt } from './claude-session'
import { liveSessionFor, liveSessions } from './claude-terminal'
import { slim } from './events'
import { toImageBlocks } from './images'

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

type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk')

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

/** A queued mid-turn prompt as the wire `user` line the mapper reads (the SDK's replay drops these). */
const queuedLine = (parentSessionId: string, queued: QueuedPrompt): WireMessage => ({
  type: 'user',
  uuid: queued.uuid,
  session_id: parentSessionId,
  parent_tool_use_id: null,
  message: { role: 'user', content: queued.prompt }
})

export class ClaudeAdapter implements AgentAdapter {
  readonly provider = 'claude' as const

  async available(): Promise<boolean> {
    return (await sdk()) !== undefined
  }

  async listSessions(cwd: string, limit = 25): Promise<AgentSessionSummary[]> {
    const module = await sdk()
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
    const module = await sdk()
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
    const module = await sdk()
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
    const response = module.query({
      prompt,
      options: {
        // Continues the very session that produced the diff — same history, same CLAUDE.md, same
        // tool state — unless the caller asked for a new one. When a terminal has this session open
        // the turn still runs here; that terminal won't show it until it resumes.
        ...(sessionId ? { resume: sessionId } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
        permissionMode: PERMISSION_MODE[options.autonomy ?? 'edit'],
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        includePartialMessages: true,
        ...(options.signal ? { abortController: abortControllerFor(options.signal) } : {})
      }
    })

    // Numbering continues from the transcript the client already holds, so a live turn's events
    // extend that log instead of colliding with it.
    const mapper = new ClaudeStreamMapper({ startSeq: options.startSeq ?? 0 })
    // The API reports output tokens cumulatively per message; the turn total is the finished
    // messages plus the one in flight. The mapper drops `message_delta.usage`, so this stays.
    let finishedTokens = 0
    let currentTokens = 0

    for await (const message of response) {
      if (message.type === 'system' && 'session_id' in message) {
        resolvedSession = message.session_id
        if (!announced) {
          yield { type: 'session', provider: this.provider, sessionId: resolvedSession }
          announced = true
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
          yield { type: 'progress', tokens: finishedTokens + currentTokens }
        }
      }

      const mapped = mapClaudeMessage(mapper, message as unknown as WireMessage, options.cwd)
      for (const [callId, files] of Object.entries(mapped.files)) yield { type: 'files', callId, files }
      for (const event of mapped.events) yield { type: 'event', event: slim(event) }

      if (message.type === 'result') {
        if (message.subtype !== 'success') yield { type: 'error', message: `claude: ${message.subtype}` }
        yield { type: 'done', sessionId: resolvedSession }
        return
      }
    }
    yield { type: 'done', sessionId: resolvedSession }
  }
}

/** The SDK takes an AbortController; the HTTP layer hands us its signal. */
function abortControllerFor(signal: AbortSignal): AbortController {
  const controller = new AbortController()
  if (signal.aborted) controller.abort()
  else signal.addEventListener('abort', () => controller.abort(), { once: true })
  return controller
}
