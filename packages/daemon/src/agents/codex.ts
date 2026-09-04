import { codexAppServer, type Notification, type ServerRequest } from './codex-app-server'
import { codexChangedPaths } from './edit-diffs/written-files'
import { shellWriteTargets } from './edit-diffs/shell-writes'
import type {
  AgentAdapter,
  AgentSessionSummary,
  AgentStreamEvent,
  SendOptions,
  Transcript,
  TranscriptItem,
  TranscriptRole
} from './types'

/**
 * Codex adapter.
 *
 * Threads are enumerated with `thread/list` (which filters on the session's cwd —
 * exactly the worktree attribution Canopy needs), replayed with `thread/read`,
 * and continued with `thread/resume` + `turn/start`. Rollout JSONL under
 * `~/.codex/sessions/**` is the source of truth behind those calls; we never
 * parse it ourselves so we stay on the supported protocol.
 */

interface CodexThread {
  id: string
  cwd?: string
  preview?: string
  name?: string | null
  createdAt?: number
  updatedAt?: number
  path?: string
  gitInfo?: { branch?: string | null } | null
  status?: { type?: string }
  turns?: Array<{ id: string; items: CodexItem[]; startedAt?: number | null }>
}

interface CodexItem {
  type: string
  id?: string
  text?: string
  content?: Array<{ type: string; text?: string }>
  command?: string | string[]
  [key: string]: unknown
}

/** Codex timestamps are unix seconds; the UI works in ms. */
function toMs(seconds?: number | null): number | undefined {
  return typeof seconds === 'number' ? seconds * 1000 : undefined
}

function itemText(item: CodexItem): string {
  if (typeof item.text === 'string') return item.text
  if (Array.isArray(item.content)) {
    return item.content
      .map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
      .filter(Boolean)
      .join('\n')
  }
  if (typeof item.command === 'string') return item.command
  if (Array.isArray(item.command)) return item.command.join(' ')
  return ''
}

const ROLE_BY_ITEM: Record<string, TranscriptRole> = {
  userMessage: 'user',
  agentMessage: 'assistant',
  reasoning: 'reasoning',
  error: 'system'
}

function toTranscriptItem(item: CodexItem, index: number, at?: number): TranscriptItem | undefined {
  const role = ROLE_BY_ITEM[item.type] ?? 'tool'
  const text = itemText(item)
  if (text === '' && role !== 'tool') return undefined
  const files = item.type === 'commandExecution' ? shellWriteTargets(itemText(item), typeof item.cwd === 'string' ? item.cwd : undefined) : codexChangedPaths(item.changes)
  return {
    id: item.id ?? `${item.type}-${index}`,
    role,
    text,
    at,
    ...(role === 'tool' ? { tool: item.type } : {}),
    ...(files.length > 0 ? { files } : {})
  }
}


/**
 * Approval routing for an unattended turn. `never` + `workspaceWrite` lets the
 * agent edit the worktree it already owns without stranding the turn on a
 * prompt no one is watching; `read-only` keeps it to analysis.
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

export class CodexAdapter implements AgentAdapter {
  readonly provider = 'codex' as const

  available(): Promise<boolean> {
    return codexAppServer().probe()
  }

  async listSessions(cwd: string, limit = 25): Promise<AgentSessionSummary[]> {
    const result = await codexAppServer().request<{ data?: CodexThread[] }>('thread/list', {
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

  async transcript(sessionId: string): Promise<Transcript> {
    const result = await codexAppServer().request<{ thread?: CodexThread }>('thread/read', {
      threadId: sessionId,
      includeTurns: true
    })
    const items: TranscriptItem[] = []
    let index = 0
    for (const turn of result.thread?.turns ?? []) {
      const at = toMs(turn.startedAt)
      for (const item of turn.items) {
        const mapped = toTranscriptItem(item, index++, at)
        if (mapped) items.push(mapped)
      }
    }
    return { items }
  }

  async *send(
    requested: string | null,
    text: string,
    options: SendOptions = {}
  ): AsyncIterable<AgentStreamEvent> {
    const server = codexAppServer()
    // Same verb either way: resume the named thread, or start a fresh one in the worktree.
    const thread = requested
      ? { id: requested, ...(await server.request<{ cwd?: string }>('thread/resume', { threadId: requested, ...(options.cwd ? { cwd: options.cwd } : {}) })) }
      : (await server.request<{ thread: { id: string; cwd?: string } }>('thread/start', { cwd: options.cwd ?? process.cwd() })).thread
    const sessionId = thread.id
    const cwd = options.cwd ?? thread.cwd ?? process.cwd()

    // Buffer everything the server emits for this thread; the generator drains it.
    const queue: AgentStreamEvent[] = []
    let notify: (() => void) | undefined
    let finished = false
    const push = (event: AgentStreamEvent): void => {
      queue.push(event)
      notify?.()
    }

    const offNotify = server.onNotification((n: Notification) => {
      if ((n.params as { threadId?: string }).threadId !== sessionId) return
      if (n.method === 'item/agentMessage/delta') {
        push({ type: 'delta', text: String((n.params as { delta?: string }).delta ?? '') })
        return
      }
      if (n.method === 'item/completed') {
        const item = (n.params as { item?: CodexItem }).item
        if (!item || item.type === 'userMessage') return
        const mapped = toTranscriptItem(item, queue.length)
        if (mapped) push({ type: 'item', item: mapped })
        return
      }
      if (n.method === 'turn/completed') {
        const turn = (n.params as { turn?: { status?: string; error?: { message?: string } } }).turn
        if (turn?.status === 'failed' && turn.error?.message) {
          push({ type: 'error', message: turn.error.message })
        }
        finished = true
        push({ type: 'done', sessionId })
        return
      }
      if (n.method === 'error') {
        const params = n.params as {
          error?: { message?: string; additionalDetails?: string | null }
          willRetry?: boolean
        }
        // Codex retries transient failures itself; only a terminal one ends the turn.
        push({
          type: 'error',
          message: params.error?.additionalDetails ?? params.error?.message ?? 'codex error'
        })
        if (params.willRetry !== true) finished = true
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

    try {
      yield { type: 'session', provider: this.provider, sessionId }
      await server.request('turn/start', {
        threadId: sessionId,
        input: [{ type: 'text', text, text_elements: [] }],
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
    }
  }
}
