import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { routes, type AgentStreamEvent } from '@canopy/shared'

import { TurnHub } from '../src/agents/turn-hub'
import { createFixtureRepo, type FixtureRepo } from './helpers/fixture-repo'
import { createTestServer, type TestServer } from './helpers/test-server'

/** A source the test feeds by hand, so a turn can be caught mid-run. */
function controlledSource() {
  const pending: AgentStreamEvent[] = []
  let wake: (() => void) | undefined
  let closed = false
  async function* source(): AsyncGenerator<AgentStreamEvent> {
    while (true) {
      while (pending.length) yield pending.shift()!
      if (closed) return
      await new Promise<void>((resolve) => (wake = resolve))
    }
  }
  return {
    source: source(),
    emit: (event: AgentStreamEvent) => (pending.push(event), wake?.()),
    close: () => ((closed = true), wake?.())
  }
}

const text = (body: string): AgentStreamEvent => ({ type: 'error', message: body })
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

async function collect(iterable: AsyncIterable<AgentStreamEvent>): Promise<AgentStreamEvent[]> {
  const out: AgentStreamEvent[] = []
  for await (const event of iterable) out.push(event)
  return out
}

describe('TurnHub', () => {
  it('keeps a turn running after its follower leaves, and replays it all to the next one', async () => {
    const hub = new TurnHub()
    const feed = controlledSource()
    const turn = hub.start('claude', null, feed.source)

    const leaving = new AbortController()
    const first: AgentStreamEvent[] = []
    const following = (async () => {
      for await (const event of turn.follow(leaving.signal)) first.push(event)
    })()
    feed.emit({ type: 'session', provider: 'claude', sessionId: 's9' })
    await tick()
    leaving.abort()
    await following

    feed.emit(text('while nobody watched'))
    await tick()
    expect(hub.isRunning('claude', 's9')).toBe(true)

    const rejoined = collect(hub.find('claude', 's9')!.follow())
    feed.emit(text('live again'))
    feed.close()
    expect((await rejoined).map((event) => event.type === 'error' ? event.message : event.type)).toEqual(['session', 'while nobody watched', 'live again'])
    expect(first.map((event) => event.type)).toEqual(['session'])
    expect(hub.isRunning('claude', 's9')).toBe(false)
  })

  it('turns a source that throws into an error event and still ends the turn', async () => {
    const hub = new TurnHub()
    async function* failing(): AsyncGenerator<AgentStreamEvent> {
      yield { type: 'session', provider: 'codex', sessionId: 't1' }
      throw new Error('spawn failed')
    }
    const turn = hub.start('codex', 't1', failing())
    expect(await collect(turn.follow())).toEqual([{ type: 'session', provider: 'codex', sessionId: 't1' }, { type: 'error', message: 'spawn failed' }])
    expect(hub.isRunning('codex', 't1')).toBe(false)
  })
})

describe('following a running turn over HTTP', () => {
  let server: TestServer
  let repo: FixtureRepo
  let worktreeId: string
  beforeEach(async () => {
    server = await createTestServer()
    repo = await createFixtureRepo()
    await repo.commit({ 'a.txt': 'a\n' }, 'init')
    const projectId = (await server.call('POST', routes.projects(), { path: repo.path, defaultBase: 'main' })).body.project.id
    worktreeId = (await server.call('GET', routes.project(projectId))).body.worktrees[0].id
  })
  afterEach(async () => {
    await server.close()
    repo.cleanup()
  })
  const runningFlag = async (): Promise<boolean | undefined> =>
    (await server.call('GET', routes.agentSessions(worktreeId))).body.sessions.find((session: { sessionId: string }) => session.sessionId === 's1')?.running

  it('lists the session as running and lets a second client follow it to the end', async () => {
    let release!: () => void
    server.agent.hold = new Promise<void>((resolve) => (release = resolve))
    const started = server.call('POST', routes.messages('claude', 's1'), { text: 'hi' })
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(await runningFlag()).toBe(true)
    const follower = server.call('GET', routes.liveTurn('claude', 's1'))
    release()
    const [original, joined] = await Promise.all([started, follower])
    expect(joined.status).toBe(200)
    expect(joined.text).toBe(original.text)

    expect((await server.call('GET', routes.liveTurn('claude', 's1'))).status).toBe(404)
    expect(await runningFlag()).toBeUndefined()
  })
})
