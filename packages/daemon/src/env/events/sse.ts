/**
 * Generic server-sent-events writer for GET routes (events, logs, resources).
 *
 * `lib/sse.ts` streams an async iterable of agent events; environment streams are push-based
 * (a bus subscription, a log tail) and stay open indefinitely, so they need a `send` callback
 * plus a heartbeat — a proxy that sees no bytes for a minute closes the socket.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'

/** Comment frame: ignored by EventSource, enough traffic to keep proxies from timing out. */
const HEARTBEAT = ': ping\n\n'
const DEFAULT_HEARTBEAT_MS = 15_000

/**
 * Hijacks the reply and runs `run` with a `send` that writes one `data:` frame per call.
 * The signal aborts when the client goes away; the response ends when `run` resolves, and a
 * rejection is delivered as a final `{"type":"error"}` frame so the UI can show it.
 */
export async function writeSse(
  _request: FastifyRequest,
  reply: FastifyReply,
  run: (send: (data: unknown) => void, signal: AbortSignal) => Promise<void>,
  opts: { heartbeatMs?: number } = {}
): Promise<void> {
  const controller = new AbortController()
  // The *response* closing means the client went away. (The request's own 'close' fires as
  // soon as its body is consumed, which would abort every stream before it starts.)
  reply.raw.on('close', () => controller.abort())

  reply.hijack()
  // Hijacking bypasses Fastify's send path, so headers hooks already queued (CORS) must be
  // written by hand or the browser rejects the stream with "Failed to fetch".
  reply.raw.writeHead(200, {
    ...(reply.getHeaders() as Record<string, string>),
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Streaming through a dev proxy dies silently without this.
    'x-accel-buffering': 'no'
  })

  const send = (data: unknown): void => {
    if (reply.raw.writableEnded) return
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  const heartbeat = setInterval(() => {
    if (!reply.raw.writableEnded) reply.raw.write(HEARTBEAT)
  }, opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS)
  heartbeat.unref?.()

  try {
    await run(send, controller.signal)
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  } finally {
    clearInterval(heartbeat)
    reply.raw.end()
  }
}
