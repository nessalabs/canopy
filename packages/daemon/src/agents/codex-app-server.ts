import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'

/**
 * Minimal JSON-RPC client for `codex app-server` (the protocol the Codex TUI and
 * the VS Code extension speak). One long-lived child process is shared by every
 * request; it is the only Codex surface that can both enumerate past threads and
 * resume one with streaming output.
 *
 * Wire format: newline-delimited JSON-RPC 2.0 on stdin/stdout. Handshake is
 * `initialize` → `initialized` notification, after which `thread/*` and `turn/*`
 * are callable.
 */

type Json = Record<string, unknown>

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export type Notification = { method: string; params: Json }
export type ServerRequest = { id: number | string; method: string; params: Json }

export class CodexAppServer {
  private child?: ChildProcessWithoutNullStreams
  private ready?: Promise<void>
  private nextId = 1
  private pending = new Map<number, Pending>()
  private notificationSinks = new Set<(n: Notification) => void>()
  private requestSinks = new Set<(r: ServerRequest) => void>()
  private buffer = ''

  constructor(private readonly bin = process.env.CODEX_BIN ?? 'codex') {}

  /** Spawns and handshakes on first use; later calls reuse the same process. */
  private start(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = (async () => {
      const child = spawn(this.bin, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] })
      this.child = child
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => this.consume(chunk))
      child.on('exit', () => {
        for (const p of this.pending.values()) p.reject(new Error('codex app-server exited'))
        this.pending.clear()
        this.child = undefined
        this.ready = undefined
      })
      child.on('error', (error) => {
        for (const p of this.pending.values()) p.reject(error)
        this.pending.clear()
      })
      await this.request('initialize', {
        clientInfo: { name: 'canopy', title: 'Canopy', version: '0.1.0' },
        capabilities: null
      })
      this.notify('initialized', {})
    })()
    return this.ready
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    let index: number
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (line.trim() === '') continue
      let message: Json
      try {
        message = JSON.parse(line) as Json
      } catch {
        continue
      }
      this.dispatch(message)
    }
  }

  private dispatch(message: Json): void {
    const id = message.id as number | undefined
    if (id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      if (message.error) {
        const error = message.error as { message?: string }
        pending.reject(new Error(error.message ?? 'codex app-server error'))
      } else {
        pending.resolve(message.result)
      }
      return
    }
    const method = message.method as string | undefined
    if (method === undefined) return
    const params = (message.params ?? {}) as Json
    if (id !== undefined) {
      for (const sink of this.requestSinks) sink({ id, method, params })
      return
    }
    for (const sink of this.notificationSinks) sink({ method, params })
  }

  private write(payload: Json): void {
    this.child?.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  notify(method: string, params: Json): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  /** Answers a server->client request (approval prompts, tool calls). */
  respond(id: number | string, result: Json): void {
    this.write({ jsonrpc: '2.0', id, result })
  }

  async request<T = unknown>(method: string, params: Json): Promise<T> {
    if (method !== 'initialize') await this.start()
    const id = this.nextId++
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.write({ jsonrpc: '2.0', id, method, params })
    return (await promise) as T
  }

  onNotification(sink: (n: Notification) => void): () => void {
    this.notificationSinks.add(sink)
    return () => this.notificationSinks.delete(sink)
  }

  onServerRequest(sink: (r: ServerRequest) => void): () => void {
    this.requestSinks.add(sink)
    return () => this.requestSinks.delete(sink)
  }

  async probe(): Promise<boolean> {
    try {
      await this.start()
      return true
    } catch {
      return false
    }
  }

  async close(): Promise<void> {
    if (!this.child) return
    const child = this.child
    child.kill()
    await once(child, 'exit').catch(() => undefined)
  }
}

let shared: CodexAppServer | undefined

export function codexAppServer(): CodexAppServer {
  shared ??= new CodexAppServer()
  return shared
}
