import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { FastifyInstance, InjectOptions } from 'fastify'

import { createAgentRegistry } from '../../src/agents/registry'
import { openDb } from '../../src/db'
import { createEventBus } from '../../src/env/events/bus'
import type { DockerHelper, EventBus } from '../../src/env/types'
import { createWorktreeBackend, type WorktreeBackend } from '../../src/env/worktree/backend'
import { runGit } from '../../src/git/exec'
import type { TextGenerator } from '../../src/drafts/draft'
import { buildServer } from '../../src/server'
import { FakeAgent } from './fake-agent'

/** A docker CLI that is never there: adapters report unavailable, runners are never used. */
export const noDocker: DockerHelper = {
  info: async () => ({ available: false, version: null, path: null }),
  run: async () => {
    throw new Error('docker is not available in tests')
  },
  stream: async () => ({ exitCode: 1 }),
  ps: async () => [],
  inspect: async () => null,
  remove: async () => undefined,
  stats: async () => new Map(),
  ensureImage: async () => {
    throw new Error('docker is not available in tests')
  },
  ensureNetwork: async () => 'canopy'
}

export const TOKEN = 'test-token'

export interface TestServer {
  app: FastifyInstance
  agent: FakeAgent
  events: EventBus
  home: string
  /** Authenticated inject; JSON bodies encoded, JSON responses decoded. */
  call<T = any>(method: InjectOptions['method'], url: string, body?: unknown): Promise<{ status: number; body: T; text: string }>
  close(): Promise<void>
}

export async function createTestServer(opts: { worktreeBackend?: WorktreeBackend; docker?: DockerHelper; generateText?: TextGenerator } = {}): Promise<TestServer> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'canopy-home-')))
  const agent = new FakeAgent()
  const events = createEventBus()
  const app = await buildServer({
    events,
    config: { home, port: 0, host: '127.0.0.1', worktreeRoot: join(home, 'worktrees'), dataRoot: join(home, 'worktrees-data'), dbPath: ':memory:', tokenPath: join(home, 'token') },
    db: openDb(':memory:'),
    token: TOKEN,
    agents: createAgentRegistry([agent]),
    // Never the real `~/.claude/projects`: a test must not find the developer's own sessions.
    claudeProjects: join(home, 'claude-projects'),
    docker: opts.docker ?? noDocker,
    generateText: opts.generateText,
    // Tests exercise the git fallback unless one opts into the real `canopyd`.
    worktreeBackend: opts.worktreeBackend ?? createWorktreeBackend(runGit, { bin: 'canopyd-not-installed-for-tests' })
  })
  await app.ready()

  return {
    app,
    agent,
    events,
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
