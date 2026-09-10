import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { routes } from '@canopy/shared'
import { createTestServer, TOKEN, type TestServer } from './helpers/test-server'
describe('cors on sse', () => {
  let server: TestServer
  beforeEach(async () => { server = await createTestServer() })
  afterEach(async () => { await server.close() })
  it('keeps access-control headers on hijacked streams', async () => {
    const res = await server.app.inject({ method: 'POST', url: routes.messages('claude', 's1'), headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', origin: 'http://localhost:5173' }, payload: JSON.stringify({ text: 'hi' }) })
    console.log('SSE headers:', JSON.stringify(res.headers))
    const get = await server.app.inject({ method: 'GET', url: routes.projects(), headers: { authorization: `Bearer ${TOKEN}`, origin: 'http://localhost:5173' } })
    console.log('GET acao:', get.headers['access-control-allow-origin'])
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173')
  })

  it('preflights DELETE, PATCH and PUT for browser clients', async () => {
    for (const method of ['DELETE', 'PATCH', 'PUT']) {
      const res = await server.app.inject({
        method: 'OPTIONS',
        url: `${routes.worktree('x')}?force=true`,
        headers: { origin: 'http://localhost:5173', 'access-control-request-method': method, 'access-control-request-headers': 'authorization,content-type' }
      })
      expect(res.statusCode).toBe(204)
      expect(res.headers['access-control-allow-methods']).toContain(method)
    }
  })
})
