import Fastify, { type FastifyInstance } from 'fastify'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { writeSse } from '../../src/env/events/sse'

const frames = (body: string): unknown[] =>
  body
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)))

describe('sse writer', () => {
  let app: FastifyInstance
  beforeEach(() => {
    app = Fastify()
  })
  afterEach(async () => app.close())

  it('writes one data frame per send and ends when run resolves', async () => {
    app.get('/stream', async (request, reply) => {
      await writeSse(request, reply, async (send) => {
        send({ type: 'hello', seq: 0 })
        send({ type: 'host', seq: 1 })
      })
    })
    const response = await app.inject({ method: 'GET', url: '/stream' })
    expect(response.headers['content-type']).toBe('text/event-stream')
    expect(response.headers['x-accel-buffering']).toBe('no')
    expect(frames(response.body)).toEqual([
      { type: 'hello', seq: 0 },
      { type: 'host', seq: 1 }
    ])
  })

  it('emits heartbeat comments so a proxy keeps the connection', async () => {
    app.get('/beat', async (request, reply) => {
      await writeSse(request, reply, async () => new Promise((resolve) => setTimeout(resolve, 40)), { heartbeatMs: 10 })
    })
    const response = await app.inject({ method: 'GET', url: '/beat' })
    expect(response.body).toContain(': ping\n\n')
  })

  it('reports a failing run as a final error frame', async () => {
    app.get('/boom', async (request, reply) => {
      await writeSse(request, reply, async () => {
        throw new Error('nope')
      })
    })
    expect(frames((await app.inject({ method: 'GET', url: '/boom' })).body)).toEqual([{ type: 'error', message: 'nope' }])
  })

  it('aborts the signal when the client goes away', async () => {
    let aborted = false
    app.get('/abort', async (request, reply) => {
      await writeSse(request, reply, async (send, signal) => {
        signal.addEventListener('abort', () => {
          aborted = true
        })
        send({ type: 'hello', seq: 0 })
      })
    })
    await app.inject({ method: 'GET', url: '/abort' })
    // inject closes the socket once the handler ends; the abort follows.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(aborted).toBe(true)
  })
})
