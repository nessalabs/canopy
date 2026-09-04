import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { routes } from '@canopy/shared'

import { formatReviewPrompt } from '../src/review/review-prompt'
import { createFixtureRepo, type FixtureRepo } from './helpers/fixture-repo'
import { createTestServer, sseEvents, type TestServer } from './helpers/test-server'

describe('review prompt', () => {
  it('matches the documented shape', () => {
    const prompt = formatReviewPrompt({
      branch: 'main',
      comments: [
        { file: 'src/lib/webhooks.ts', line: 57, side: 'old', text: 'Why did this guard go away?' },
        { file: 'src/lib/webhooks.ts', line: 42, side: 'new', text: 'Wrap this and the side effect in one transaction.', code: 'await db.insert(deliveries).values({ id })' }
      ]
    })
    expect(prompt).toBe(
      [
        'Code review on the changes you just made. Each note below is anchored to a line in the diff. Branch: main.',
        '',
        'src/lib/webhooks.ts',
        '  - src/lib/webhooks.ts:42',
        '    > await db.insert(deliveries).values({ id })',
        '    Wrap this and the side effect in one transaction.',
        '  - src/lib/webhooks.ts:57 (removed line)',
        '    Why did this guard go away?',
        '',
        'Address each note. Where you disagree, say so and explain instead of changing the code. Keep the changes scoped to these notes.'
      ].join('\n')
    )
  })
})

describe('comments and review', () => {
  let server: TestServer
  let repo: FixtureRepo
  let worktreeId: string
  beforeEach(async () => {
    server = await createTestServer()
    repo = await createFixtureRepo()
    await repo.commit({ 'a.txt': 'one\n' }, 'init')
    const project = (await server.call('POST', routes.projects(), { path: repo.path })).body.project
    worktreeId = (await server.call('GET', routes.project(project.id))).body.worktrees[0].id
  })
  afterEach(async () => {
    await server.close()
    repo.cleanup()
  })

  const addComment = (text: string, extra: Record<string, unknown> = {}) =>
    server.call('POST', routes.comments(worktreeId), { file: 'a.txt', line: 1, side: 'new', text, code: 'one', ...extra })

  it('persists comments with code and commit anchors, and cascades on delete', async () => {
    const created = await addComment('first', { commitSha: 'abc123' })
    expect(created.status).toBe(201)
    expect(created.body.comment).toMatchObject({ code: 'one', commitSha: 'abc123', sent: false })
    expect((await server.call('GET', routes.comments(worktreeId))).body.comments).toHaveLength(1)
    expect((await server.call('DELETE', routes.comment(worktreeId, created.body.comment.id))).status).toBe(204)
    expect((await server.call('GET', routes.comments(worktreeId))).body.comments).toEqual([])
  })

  it('streams the review turn to the fake agent and marks comments sent', async () => {
    await addComment('tighten this')
    const response = await server.call('POST', routes.review(worktreeId), { provider: 'claude', sessionId: 's1' })
    expect(response.status).toBe(200)
    const events = sseEvents(response.text) as Array<{ type: string }>
    expect(events.map((e) => e.type)).toEqual(['session', 'delta', 'done'])
    expect(server.agent.sent[0]?.text).toContain('a.txt:1')
    expect(server.agent.sent[0]?.options?.cwd).toBe(repo.path)
    expect(server.agent.abortedEarly).toBe(false)

    const [comment] = (await server.call('GET', routes.comments(worktreeId))).body.comments
    expect(comment).toMatchObject({ sent: true, sentSessionId: 's1' })
    expect((await server.call('POST', routes.review(worktreeId), { provider: 'claude', sessionId: 's1' })).status).toBe(400)
  })

  it('starts a new session when sessionId is null, then marks and pins the minted one', async () => {
    await addComment('fresh eyes please')
    const response = await server.call('POST', routes.review(worktreeId), { provider: 'claude', sessionId: null })
    expect(response.status).toBe(200)
    expect(server.agent.sent[0]?.sessionId).toBeNull()
    expect(sseEvents(response.text)[0]).toEqual({ type: 'session', provider: 'claude', sessionId: 's-new' })
    const [comment] = (await server.call('GET', routes.comments(worktreeId))).body.comments
    expect(comment).toMatchObject({ sent: true, sentSessionId: 's-new' })
    expect((await server.call('GET', routes.agentSessions(worktreeId))).body.pinned).toEqual({ provider: 'claude', sessionId: 's-new' })
  })

  it('leaves comments unsent when the agent errors before producing anything', async () => {
    await addComment('x')
    server.agent.script = () => [{ type: 'error', message: '401 stale credentials' }]
    const response = await server.call('POST', routes.review(worktreeId), { provider: 'claude', sessionId: 's1' })
    expect(sseEvents(response.text)).toEqual([{ type: 'error', message: '401 stale credentials' }])
    expect((await server.call('GET', routes.comments(worktreeId))).body.comments[0].sent).toBe(false)
  })

  it('lists sessions, pins one, and streams free-text messages', async () => {
    const sessions = (await server.call('GET', routes.agentSessions(worktreeId))).body
    expect(sessions.sessions[0].sessionId).toBe('s1')
    expect(sessions.pinned).toBeUndefined()
    expect((await server.call('PUT', routes.agentPin(worktreeId), { provider: 'claude', sessionId: 's1' })).status).toBe(204)
    expect((await server.call('GET', routes.agentSessions(worktreeId))).body.pinned).toEqual({ provider: 'claude', sessionId: 's1' })
    expect((await server.call('GET', routes.transcript('claude', 's1'))).body.items).toHaveLength(1)
    const events = sseEvents((await server.call('POST', routes.messages('claude', 's1'), { text: 'hi', cwd: repo.path })).text)
    expect(events.map((e: any) => e.type)).toEqual(['session', 'delta', 'done'])
    expect((await server.call('GET', routes.providers())).body.providers).toEqual(['claude'])
  })
})
