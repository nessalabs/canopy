import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { FastifyInstance, InjectOptions } from 'fastify'

import { createAgentRegistry } from '../../src/agents/registry'
import { openDb } from '../../src/db'
import { buildServer } from '../../src/server'
import { FakeAgent } from './fake-agent'

export const TOKEN = 'test-token'

export interface TestServer {
  app: FastifyInstance
  agent: FakeAgent
  home: string
  /** Authenticated inject; JSON bodies encoded, JSON responses decoded. */
  call<T = any>(method: InjectOptions['method'], url: string, body?: unknown): Promise<{ status: number; body: T; text: string }>
  close(): Promise<void>
}

export async function createTestServer(): Promise<TestServer> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'canopy-home-')))
  const agent = new FakeAgent()
  const app = await buildServer({
    config: { home, port: 0, host: '127.0.0.1', worktreeRoot: join(home, 'worktrees'), dbPath: ':memory:', tokenPath: join(home, 'token') },
    db: openDb(':memory:'),
    token: TOKEN,
    agents: createAgentRegistry([agent])
  })
  await app.ready()

  return {
    app,
    agent,
    home,
    async call(method, url, body) {
      const response = await app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        payload: body !== undefined ? JSON.stringify(body) : undefined
      })
      const text = response.body
      let parsed: unknown = undefined
      try {
        parsed = text ? JSON.parse(text) : undefined
      } catch {
        parsed = undefined
      }
      return { status: response.statusCode, body: parsed as never, text }
    },
    async close() {
      await app.close()
      rmSync(home, { recursive: true, force: true })
    }
  }
}

/** Parses the `data:` frames of an SSE body. */
export const sseEvents = (text: string): unknown[] =>
  text
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)))
