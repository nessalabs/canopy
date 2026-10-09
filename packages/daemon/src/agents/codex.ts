import type { AgentEvent, CodexAppServerFrame } from '@canopy/shared/agent-stream'
import { CodexAppServerMapper } from '@canopy/shared/agent-stream'

import { codexAppServer, type Notification, type ServerRequest } from './codex-app-server'
import { codexItemFiles, filesFromThread, framesFromThread, type CodexItem, type CodexThread, type RawFrame } from './codex-replay'
import { slim } from './events'
import type { AgentAdapter, AgentSessionSummary, AgentStreamEvent, SendOptions, TranscriptResponse } from './types'

/**
 * Codex adapter.
 *
 * Threads are enumerated with `thread/list` (which filters on the session's cwd — exactly the
 * worktree attribution Canopy needs), replayed with `thread/read`, and continued with
 * `thread/resume` + `turn/start`. Every frame — the server's notifications, the `thread/start`
 * reply, and Canopy's own outgoing `turn/start` — is fed to nessa's `CodexAppServerMapper`, so
 * Codex and Claude produce the one `AgentEvent` model the UI folds. Rollout JSONL under
 * `~/.codex/sessions/**` is the source of truth behind those calls; we never parse it ourselves.
 */

interface ListThread {
  id: string
  cwd?: string
  preview?: string
  name?: string | null
  createdAt?: number
  updatedAt?: number
  path?: string
  gitInfo?: { branch?: string | null } | null
  status?: { type?: string }
}

/** Codex timestamps are unix seconds; the UI works in ms. */
function toMs(seconds?: number | null): number | undefined {
  return typeof seconds === 'number' ? seconds * 1000 : undefined
}

/**
 * Approval routing for an unattended turn. `never` + `workspaceWrite` lets the agent edit the
 * worktree it already owns without stranding the turn on a prompt no one is watching; `read-only`
 * keeps it to analysis.
 */
function sandboxFor(autonomy: SendOptions['autonomy'], cwd: string) {
  if (autonomy === 'read-only') return { type: 'readOnly' as const, networkAccess: false }
  if (autonomy === 'full') return { type: 'dangerFullAccess' as const }
  return {
    type: 'workspaceWrite' as const,
    writableRoots: [cwd],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  }
}

const frame = (raw: RawFrame): CodexAppServerFrame => raw as unknown as CodexAppServerFrame

export class CodexAdapter implements AgentAdapter {
  readonly provider = 'codex' as const
  /** Threads with a turn running now, and how to stop each — what `interrupt` reaches. */
  private readonly running = new Map<string, () => void>()

  available(): Promise<boolean> {
    return codexAppServer().probe()
  }

  async listSessions(cwd: string, limit = 25): Promise<AgentSessionSummary[]> {
    const result = await codexAppServer().request<{ data?: ListThread[] }>('thread/list', {
      cwd: [cwd],
      limit,
      sortKey: 'updated_at',
      sortDirection: 'desc'
    })
    return (result.data ?? []).map((thread) => ({
      provider: this.provider,
      sessionId: thread.id,
      title: thread.name?.trim() || thread.preview?.slice(0, 80) || thread.id.slice(0, 8),
      cwd: thread.cwd,
      gitBranch: thread.gitInfo?.branch ?? undefined,
      createdAt: toMs(thread.createdAt),
      updatedAt: toMs(thread.updatedAt) ?? 0,
      preview: thread.preview,
      transcriptPath: thread.path,
      active: thread.status?.type === 'active'
    }))
  }

  async transcript(sessionId: string): Promise<TranscriptResponse> {
    const result = await codexAppServer().request<{ thread?: CodexThread }>('thread/read', {
      threadId: sessionId,
      includeTurns: true
    })
    const thread = result.thread ?? { id: sessionId }
    const mapper = new CodexAppServerMapper()
    const events: AgentEvent[] = []
    for (const raw of framesFromThread(thread)) for (const event of mapper.map(frame(raw))) events.push(slim(event))
    return {
      events,
      files: filesFromThread(thread),
      extras: {},
      nextSeq: (events.at(-1)?.seq ?? -1) + 1
    }
  }

  async *send(requested: string | null, text: string, options: SendOptions = {}): AsyncIterable<AgentStreamEvent> {
    const server = codexAppServer()
    // Same verb either way: resume the named thread, or start a fresh one in the worktree.
    const started = requested
      ? { id: requested, ...(await server.request<{ cwd?: string }>('thread/resume', { threadId: requested, ...(options.cwd ? { cwd: options.cwd } : {}) })) }
      : (await server.request<{ thread: { id: string; cwd?: string } }>('thread/start', { cwd: options.cwd ?? process.cwd() })).thread
    const sessionId = started.id
    const cwd = options.cwd ?? started.cwd ?? process.cwd()

    const mapper = new CodexAppServerMapper({ startSeq: options.startSeq ?? 0 })

    // Buffer everything the server emits for this thread; the generator drains it.
    const queue: AgentStreamEvent[] = []
    let notify: (() => void) | undefined
    let finished = false
    const push = (event: AgentStreamEvent): void => {
      queue.push(event)
      notify?.()
    }
    const emitEvents = (raw: RawFrame): void => {
      for (const event of mapper.map(frame(raw))) push({ type: 'event', event: slim(event) })
    }

    // The thread's own description names the model and cwd; feeding the reply gives `session_started`.
    emitEvents({ result: { thread: { id: sessionId, cwd: started.cwd ?? cwd } } })

    const offNotify = server.onNotification((n: Notification) => {
      if ((n.params as { threadId?: string }).threadId !== sessionId) return
      if (n.method === 'item/started') {
        const item = (n.params as { item?: CodexItem }).item
        if (item?.id) {
          const files = codexItemFiles(item)
          if (files.length > 0) push({ type: 'files', callId: item.id, files })
        }
      }
      if (n.method === 'error') {
        const params = n.params as { error?: { message?: string; additionalDetails?: string | null }; willRetry?: boolean }
        // Codex retries transient failures itself; only a terminal one ends the turn. A top-level
        // `error` frame (not the mapped event) is what un-marks a review's comments.
        push({ type: 'error', message: params.error?.additionalDetails ?? params.error?.message ?? 'codex error' })
        if (params.willRetry !== true) finished = true
        return
      }
      emitEvents({ method: n.method, params: n.params })
      if (n.method === 'turn/completed') {
        const turn = (n.params as { turn?: { status?: string; error?: { message?: string } } }).turn
        if (turn?.status === 'failed' && turn.error?.message) push({ type: 'error', message: turn.error.message })
        finished = true
        push({ type: 'done', sessionId })
      }
    })

    // Unattended turn: auto-approve the actions the chosen autonomy already allows.
    const offRequest = server.onServerRequest((request: ServerRequest) => {
      if (request.method.endsWith('requestApproval') || request.method.endsWith('Approval')) {
        server.respond(request.id, { decision: options.autonomy === 'read-only' ? 'denied' : 'approved' })
      }
    })

    const abort = (): void => {
      void server.request('turn/interrupt', { threadId: sessionId }).catch(() => undefined)
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    this.running.set(sessionId, abort)

    try {
      yield { type: 'session', provider: this.provider, sessionId }
      // Canopy's own prompt: feeding the outgoing request gives the `user_message` turn.
      const input = [{ type: 'text', text, text_elements: [] }]
      emitEvents({ method: 'turn/start', params: { threadId: sessionId, input } })
      while (queue.length > 0) yield queue.shift() as AgentStreamEvent
      await server.request('turn/start', {
        threadId: sessionId,
        input,
        cwd,
        approvalPolicy: options.autonomy === 'read-only' ? 'untrusted' : 'never',
        sandboxPolicy: sandboxFor(options.autonomy, cwd)
      })
      while (!finished || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            notify = resolve
          })
          notify = undefined
          continue
        }
        yield queue.shift() as AgentStreamEvent
      }
    } finally {
      offNotify()
      offRequest()
      options.signal?.removeEventListener('abort', abort)
      if (this.running.get(sessionId) === abort) this.running.delete(sessionId)
    }
  }

  /** Asks the thread's running turn to stop; it still ends with `turn/completed`, so the stream finishes cleanly. */
  async interrupt(sessionId: string): Promise<boolean> {
    const abort = this.running.get(sessionId)
    abort?.()
    return abort !== undefined
  }
}
