import type {
  AgentAdapter,
  AgentSessionSummary,
  AgentStreamEvent,
  SendOptions,
  Transcript,
  TranscriptItem,
  TranscriptRole
} from './types'
import { open, stat } from 'node:fs/promises'

import { deliver, liveSessionFor, liveSessions, liveStatus, type LiveSession } from './claude-live'
import { readSessionExtras, sessionFilePath, type QueuedPrompt } from './claude-session'
import { imagesFromBlocks, toImageBlocks } from './images'
import { claudeWrittenFiles } from './edit-diffs/written-files'

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
 * The SDK is loaded lazily so Canopy still boots (Codex-only) when it isn't installed.
 */

type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk')

let sdkPromise: Promise<SdkModule | undefined> | undefined

async function sdk(): Promise<SdkModule | undefined> {
  sdkPromise ??= import('@anthropic-ai/claude-agent-sdk').catch(() => undefined)
  return sdkPromise
}

interface ContentBlock {
  type: string
  id?: string
  text?: string
  name?: string
  thinking?: string
  input?: unknown
  content?: unknown
}

function flatten(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) =>
      typeof part === 'object' && part && 'text' in part ? String((part as { text: unknown }).text) : ''
    )
    .filter(Boolean)
    .join('\n')
}

/**
 * Splits one API message into the lines the Agent tab renders. A single
 * assistant message can carry prose *and* several tool calls; collapsing them
 * into one bubble loses the tool trail the reviewer is scrolling for, so text
 * and each tool block become separate items.
 */
export function itemsFromBlocks(role: string, blocks: ContentBlock[], idBase: string, cwd?: string): TranscriptItem[] {
  const items: TranscriptItem[] = []
  const textOf = (type: 'text' | 'thinking'): string =>
    blocks
      .filter((block) => block.type === type)
      .map((block) => (type === 'text' ? (block.text ?? '') : (block.thinking ?? '')))
      .filter(Boolean)
      .join('\n')
      .trim()

  // Raw thinking is redacted (empty). What survives is the model's own summary of a step,
  // which Claude Code shows as a "summarized" line in the conversation — so do we.
  const thinking = textOf('thinking')
  if (thinking !== '') items.push({ id: `${idBase}:thinking`, role: 'reasoning', text: thinking })

  const prose = textOf('text')
  const images = role === 'user' ? imagesFromBlocks(blocks, prose) : []
  if ((prose !== '' && !isNoise(prose)) || images.length > 0) {
    const proseRole: TranscriptRole = role === 'assistant' ? 'assistant' : 'user'
    items.push({ id: `${idBase}:text`, role: proseRole, text: prose, ...(images.length > 0 ? { images } : {}) })
  }

  blocks.forEach((block, index) => {
    if (block.type === 'tool_use') {
      const title = describeInput(block.input)
      const files = claudeWrittenFiles(block.name, block.input, cwd)
      items.push({
        id: `${idBase}:use:${index}`,
        role: 'tool',
        tool: block.name ?? 'tool',
        text: summarizeInput(block.input),
        ...(title ? { title } : {}),
        ...(files.length > 0 ? { files } : {}),
        ...(block.id ? { toolUseId: block.id } : {})
      })
      return
    }
    if (block.type === 'tool_result') {
      const text = flatten(block.content).trim()
      if (text === '') return
      items.push({ id: `${idBase}:result:${index}`, role: 'tool', tool: 'result', text })
    }
  })
  return items
}

/** A stored message body — plain text or content blocks — as blocks. */
const toBlocks = (content: unknown): ContentBlock[] =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : ((content ?? []) as ContentBlock[])

/** User prompts Claude Code delivered right after the given entry, as user turns. */
function queuedAfter(parentUuid: string, queued: QueuedPrompt[]): TranscriptItem[] {
  return queued.filter((q) => q.parentUuid === parentUuid).flatMap((q) => itemsFromBlocks('user', toBlocks(q.prompt), q.uuid))
}

/** The agent's own one-line description of a call, when the tool takes one. */
function describeInput(input: unknown): string | undefined {
  const description = (input as { description?: unknown } | null)?.description
  return typeof description === 'string' && description.trim() !== '' ? description.trim() : undefined
}

/** One-line gist of a tool call's arguments — enough to recognize, short enough to list. */
function summarizeInput(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const record = input as Record<string, unknown>
  for (const key of ['command', 'file_path', 'pattern', 'path', 'prompt', 'url']) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return Object.keys(record).join(', ')
}

/** Transcript entries Claude Code writes for its own bookkeeping, not the conversation. */
function isNoise(text: string): boolean {
  return (
    text.startsWith('<local-command-') ||
    text.startsWith('<command-name>') ||
    text.startsWith('<system-reminder>')
  )
}

const PERMISSION_MODE = {
  'read-only': 'plan',
  edit: 'acceptEdits',
  full: 'bypassPermissions'
} as const

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

  async transcript(sessionId: string, cwd?: string): Promise<Transcript> {
    const module = await sdk()
    if (!module) return { items: [] }
    const [messages, extras, live] = await Promise.all([
      module.getSessionMessages(sessionId, cwd ? { dir: cwd } : undefined),
      readSessionExtras(cwd, sessionId),
      liveSessionFor(sessionId)
    ])
    const items: TranscriptItem[] = []
    let model: string | undefined
    for (const message of messages) {
      const payload = message.message as { role?: string; content?: unknown; model?: string } | undefined
      if (!payload?.role) continue
      if (payload.role === 'assistant' && payload.model && !payload.model.startsWith('<')) model = payload.model
      items.push(...itemsFromBlocks(payload.role, toBlocks(payload.content), message.uuid, cwd))
      items.push(...queuedAfter(message.uuid, extras.queued))
    }
    return { items, model, effort: extras.effort, live: live !== undefined }
  }

  private async *sendLive(live: LiveSession, text: string, options: SendOptions): AsyncIterable<AgentStreamEvent> {
    const cwd = options.cwd ?? live.cwd
    if (!cwd) {
      yield { type: 'error', message: 'live session has no working directory' }
      return
    }
    const file = sessionFilePath(cwd, live.sessionId)
    const tail = tailLiveTurn(live, file, options.signal)
    try {
      await deliver(live, text)
    } catch (error) {
      yield { type: 'error', message: `could not reach the terminal session: ${error instanceof Error ? error.message : String(error)}` }
      return
    }
    yield* tail
    yield { type: 'done', sessionId: live.sessionId }
  }

  async *send(
    sessionId: string | null,
    text: string,
    options: SendOptions = {}
  ): AsyncIterable<AgentStreamEvent> {
    const module = await sdk()
    if (!module) {
      yield { type: 'error', message: '@anthropic-ai/claude-agent-sdk is not installed' }
      return
    }
    let resolvedSession = sessionId ?? ''
    let index = 0
    // A fresh session's id is only known once the SDK's init message arrives (below).
    if (sessionId) yield { type: 'session', provider: this.provider, sessionId }

    // A session open in a terminal gets the prompt handed to that process, so the user
    // sees it there live and there is never a second writer on the session file.
    // Images cannot ride the peer socket, so those turns still resume through the SDK.
    const live = sessionId && !options.images?.length ? await liveSessionFor(sessionId) : undefined
    if (live) {
      yield* this.sendLive(live, text, options)
      return
    }

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
        // Continues the very session that produced the diff — same history, same
        // CLAUDE.md, same tool state — unless the caller asked for a new one.
        ...(sessionId ? { resume: sessionId } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
        permissionMode: PERMISSION_MODE[options.autonomy ?? 'edit'],
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        includePartialMessages: true,
        ...(options.signal ? { abortController: abortControllerFor(options.signal) } : {})
      }
    })

    // The API reports output tokens cumulatively per message; the turn total is the
    // finished messages plus the one in flight.
    let finishedTokens = 0
    let currentTokens = 0
    for await (const message of response) {
      if (message.type === 'system' && 'session_id' in message) {
        resolvedSession = message.session_id
        if (!sessionId) yield { type: 'session', provider: this.provider, sessionId: resolvedSession }
      }
      if (message.type === 'stream_event') {
        const event = message.event as {
          type?: string
          delta?: { type?: string; text?: string }
          usage?: { output_tokens?: number }
        }
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          yield { type: 'delta', text: event.delta.text ?? '' }
        }
        if (event.type === 'message_start') {
          finishedTokens += currentTokens
          currentTokens = 0
        }
        if (event.type === 'message_delta' && typeof event.usage?.output_tokens === 'number') {
          currentTokens = event.usage.output_tokens
          yield { type: 'progress', tokens: finishedTokens + currentTokens }
        }
        continue
      }
      if (message.type === 'assistant' || message.type === 'user') {
        const payload = message.message as { role?: string; content?: unknown }
        const idBase = message.uuid ?? `${message.type}-${index++}`
        for (const item of itemsFromBlocks(payload.role ?? message.type, toBlocks(payload.content), idBase, options.cwd)) {
          // Assistant prose already arrived as deltas; only the tool trail is new.
          if (item.role === 'assistant') continue
          yield { type: 'item', item }
        }
        continue
      }
      if (message.type === 'result') {
        if (message.subtype !== 'success') {
          yield { type: 'error', message: `claude: ${message.subtype}` }
        }
        yield { type: 'done', sessionId: resolvedSession }
        return
      }
    }
    yield { type: 'done', sessionId: resolvedSession }
  }
}

/** How long to wait for the terminal to start on a delivered prompt before giving up the tail. */
const LIVE_PICKUP_MS = 20_000
const LIVE_POLL_MS = 500

/**
 * Follows the session file while the terminal works on the delivered prompt. Every entry
 * the terminal appends becomes an item; the prompt's own echo is skipped because the UI
 * already shows what it sent. Ends when the terminal goes idle again. The starting offset
 * is taken on first pull, so create the generator before delivering the prompt.
 */
async function* tailLiveTurn(live: LiveSession, file: string, signal?: AbortSignal): AsyncIterable<AgentStreamEvent> {
  let offset = await stat(file).then((info) => info.size, () => 0)
  let remainder = ''
  let sawBusy = false
  const deadline = Date.now() + LIVE_PICKUP_MS
  while (!signal?.aborted) {
    await new Promise((resolve) => setTimeout(resolve, LIVE_POLL_MS))
    const size = await stat(file).then((info) => info.size, () => 0)
    if (size > offset) {
      const lines = (remainder + (await readChunk(file, offset, size))).split('\n')
      offset = size
      remainder = lines.pop() ?? ''
      for (const line of lines) {
        for (const item of itemsFromLine(line)) {
          if (item.role !== 'user') yield { type: 'item', item }
        }
      }
    }
    const status = await liveStatus(live.pid)
    if (status === 'busy') sawBusy = true
    if (sawBusy && status === 'idle') return
    if (!sawBusy && Date.now() > deadline) return
  }
}

async function readChunk(file: string, start: number, end: number): Promise<string> {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(end - start)
    await handle.read(buffer, 0, buffer.length, start)
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

/** Transcript items for one session-file line; bookkeeping lines yield none. */
export function itemsFromLine(line: string): TranscriptItem[] {
  let entry: { type?: string; uuid?: string; cwd?: string; message?: { role?: string; content?: unknown } }
  try {
    entry = JSON.parse(line) as typeof entry
  } catch {
    return []
  }
  if ((entry.type !== 'user' && entry.type !== 'assistant') || !entry.message?.role || !entry.uuid) return []
  return itemsFromBlocks(entry.message.role, toBlocks(entry.message.content), entry.uuid, entry.cwd)
}

/** The SDK takes an AbortController; the HTTP layer hands us its signal. */
function abortControllerFor(signal: AbortSignal): AbortController {
  const controller = new AbortController()
  if (signal.aborted) controller.abort()
  else signal.addEventListener('abort', () => controller.abort(), { once: true })
  return controller
}
