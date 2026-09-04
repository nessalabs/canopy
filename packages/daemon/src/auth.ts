import { timingSafeEqual } from 'node:crypto'

import type { FastifyInstance } from 'fastify'

import { API_PREFIX, ApiError } from '@canopy/shared'

function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented) return false
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Bearer-token gate on everything under the API prefix; static assets and /healthz stay open. */
export function registerAuth(app: FastifyInstance, token: string): void {
  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith(API_PREFIX)) return
    const presented = request.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!tokenMatches(presented, token)) throw new ApiError(401, 'unauthorized', 'missing or invalid bearer token')
  })
}
