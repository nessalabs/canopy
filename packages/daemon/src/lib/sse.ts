import type { FastifyReply, FastifyRequest } from 'fastify'

import type { AgentStreamEvent } from '@canopy/shared'

/**
 * Streams AgentStreamEvents as server-sent events: one `data:` frame per event. Closing the
 * connection fires the signal handed to `run`, which stops *this client following*; a turn runs
 * on in the `TurnHub` regardless, and only the interrupt route stops it.
 */
export async function streamSse(
  _request: FastifyRequest,
  reply: FastifyReply,
  run: (signal: AbortSignal) => AsyncIterable<AgentStreamEvent>
): Promise<void> {
  const controller = new AbortController()
  // The *response* closing means the client went away. (The request's own 'close' fires as
  // soon as its body is consumed, which would end every stream before it starts.)
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
  const emit = (event: AgentStreamEvent): void => {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  try {
    for await (const event of run(controller.signal)) emit(event)
  } catch (error) {
    emit({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  } finally {
    reply.raw.end()
  }
}
