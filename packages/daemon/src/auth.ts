import { timingSafeEqual } from 'node:crypto'

import type { FastifyInstance } from 'fastify'

import { API_PREFIX, ApiError, SOCKET_PROTOCOL } from '@canopy/shared'

function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented) return false
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** The token a socket offers as its second subprotocol, after `SOCKET_PROTOCOL`. */
function socketToken(offered: string | undefined): string | undefined {
  const [protocol, token] = (offered ?? '').split(',').map((part) => part.trim())
  return protocol === SOCKET_PROTOCOL ? token : undefined
}

/**
 * Bearer-token gate on everything under the API prefix; static assets and /healthz stay open. A
 * browser cannot put a header on a WebSocket, so an upgrade carries the token as a subprotocol.
 */
export function registerAuth(app: FastifyInstance, token: string): void {
  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith(API_PREFIX)) return
    const upgrade = request.headers.upgrade?.toLowerCase() === 'websocket'
    const offered = upgrade ? socketToken(request.headers['sec-websocket-protocol']) : undefined
    const presented = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? offered
    if (!tokenMatches(presented, token)) throw new ApiError(401, 'unauthorized', 'missing or invalid bearer token')
  })
}
