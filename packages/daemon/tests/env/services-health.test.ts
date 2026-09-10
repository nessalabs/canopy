import { createServer, type Server } from 'node:http'
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import type { HealthCheck } from '@canopy/shared'

import { probe, resolveHealth } from '../../src/env/services/health'

const listen = (server: Server | TcpServer): Promise<number> =>
  new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      done(typeof address === 'object' && address ? address.port : 0)
    })
  })

const check = (partial: Partial<HealthCheck>): HealthCheck => ({ interval: '3s', timeout: '3s', retries: 10, start_period: '0s', ...partial }) as HealthCheck

const shellContext = { cwd: process.cwd(), env: {} as Record<string, string> }

describe('resolveHealth', () => {
  it('is none when the service declares no check', () => {
    expect(resolveHealth(undefined, (text) => text)).toEqual({ kind: 'none', target: '', intervalMs: 3000, timeoutMs: 3000, retries: 10, startPeriodMs: 0 })
  })

  it('interpolates the target and parses every duration', () => {
    const resolved = resolveHealth(check({ http: 'http://localhost:${ports.web}/up', interval: '500ms', timeout: '2s', retries: 3, start_period: '1m' }), (text) =>
      text.replace('${ports.web}', '41234')
    )
    expect(resolved).toEqual({ kind: 'http', target: 'http://localhost:41234/up', intervalMs: 500, timeoutMs: 2000, retries: 3, startPeriodMs: 60_000 })
  })

  it('renders a numeric tcp port and a cmd', () => {
    expect(resolveHealth(check({ tcp: 8080 }), (text) => text).target).toBe('8080')
    expect(resolveHealth(check({ tcp: '${ports.api}' }), () => '5555')).toMatchObject({ kind: 'tcp', target: '5555' })
    expect(resolveHealth(check({ cmd: 'pg_isready' }), (text) => text)).toMatchObject({ kind: 'cmd', target: 'pg_isready' })
  })

  it('falls back to the defaults for a malformed duration instead of throwing', () => {
    expect(resolveHealth(check({ tcp: 1, interval: 'soon' }), (text) => text).intervalMs).toBe(3000)
  })
})

describe('probe', () => {
  const servers: Array<Server | TcpServer> = []
  afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise((done) => server.close(() => done(null)))
  })

  it('tcp: connects to a listening socket and fails on a closed one', async () => {
    const server = createTcpServer((socket) => socket.end())
    servers.push(server)
    const port = await listen(server)

    expect(await probe(resolveHealth(check({ tcp: port }), (t) => t), shellContext)).toEqual({ ok: true })

    const closed = createTcpServer()
    const freePort = await listen(closed)
    await new Promise((done) => closed.close(() => done(null)))
    const result = await probe(resolveHealth(check({ tcp: freePort }), (t) => t), shellContext)
    expect(result.ok).toBe(false)
    expect(result.detail).toBeTruthy()
  })

  it('tcp: rejects a target that is not a port', async () => {
    expect(await probe({ kind: 'tcp', target: '${ports.web}', intervalMs: 100, timeoutMs: 100, retries: 1, startPeriodMs: 0 }, shellContext)).toMatchObject({ ok: false })
  })

  it('http: 200 and 302 are healthy, 500 is not', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/ok') response.writeHead(200).end('fine')
      else if (request.url === '/moved') response.writeHead(302, { location: 'https://example.invalid/' }).end()
      else response.writeHead(500).end('boom')
    })
    servers.push(server)
    const port = await listen(server)
    const at = (path: string) => resolveHealth(check({ http: `http://127.0.0.1:${port}${path}` }), (t) => t)

    expect(await probe(at('/ok'), shellContext)).toEqual({ ok: true })
    expect(await probe(at('/moved'), shellContext)).toEqual({ ok: true })
    expect(await probe(at('/nope'), shellContext)).toMatchObject({ ok: false, detail: 'HTTP 500' })
  })

  it('http: a hung response fails on the timeout rather than hanging the poll loop', async () => {
    const server = createServer(() => {})
    servers.push(server)
    const port = await listen(server)
    const resolved = resolveHealth(check({ http: `http://127.0.0.1:${port}/`, timeout: '300ms' }), (t) => t)

    const started = Date.now()
    const result = await probe(resolved, shellContext)
    expect(result.ok).toBe(false)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('http: an unreachable host is unhealthy, never a throw', async () => {
    expect(await probe(resolveHealth(check({ http: 'http://127.0.0.1:1/' }), (t) => t), shellContext)).toMatchObject({ ok: false })
  })

  it('cmd: exit 0 passes, non-zero fails with the last output line, and the env is visible', async () => {
    expect(await probe(resolveHealth(check({ cmd: 'exit 0' }), (t) => t), shellContext)).toEqual({ ok: true })
    expect(await probe(resolveHealth(check({ cmd: 'echo nope >&2; exit 7' }), (t) => t), shellContext)).toMatchObject({ ok: false, detail: 'nope' })
    expect(await probe(resolveHealth(check({ cmd: 'test "$CANOPY_PROBE" = yes' }), (t) => t), { cwd: process.cwd(), env: { CANOPY_PROBE: 'yes' } })).toEqual({ ok: true })
  })

  it('cmd: a hanging command is killed by the timeout', async () => {
    const resolved = resolveHealth(check({ cmd: 'sleep 10', timeout: '300ms' }), (t) => t)
    const started = Date.now()
    expect(await probe(resolved, shellContext)).toMatchObject({ ok: false })
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('none: always healthy', async () => {
    expect(await probe(resolveHealth(undefined, (t) => t), shellContext)).toEqual({ ok: true })
  })
})
