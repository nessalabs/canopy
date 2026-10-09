import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { routes } from '@canopy/shared'

import { changedLines, parseDraft } from '../src/drafts/draft'
import { createFixtureRepo, type FixtureRepo } from './helpers/fixture-repo'
import { createTestServer, type TestServer } from './helpers/test-server'

describe('parseDraft', () => {
  it('splits the title from the body', () => {
    expect(parseDraft('Fix the thing\n\nIt was broken.\n- and now it is not')).toEqual({ title: 'Fix the thing', body: 'It was broken.\n- and now it is not' })
  })

  it('drops a fence around the whole reply and tolerates a bare title', () => {
    expect(parseDraft('```\nAdd a button\n```')).toEqual({ title: 'Add a button', body: '' })
  })

  it('keeps fences inside the body', () => {
    expect(parseDraft('Title\n\n```ts\nx\n```\nmore').body).toBe('```ts\nx\n```\nmore')
    expect(parseDraft('Title\n\n```ts\ncode\n```').body).toBe('```ts\ncode\n```')
  })
})

describe('changedLines', () => {
  it('adds up additions and removals, counting binary files as none', () => {
    expect(changedLines('3\t1\ta.txt\n-\t-\tlogo.png\n10\t0\tb.txt\n')).toBe(14)
    expect(changedLines('')).toBe(0)
  })
})

describe('draft route', () => {
  let server: TestServer
  let repo: FixtureRepo
  let worktreeId: string
  let projectId: string
  const prompts: string[] = []

  beforeEach(async () => {
    prompts.length = 0
    server = await createTestServer({
      generateText: async (prompt) => {
        prompts.push(prompt)
        return 'Change a\n\nBecause it needed changing.'
      }
    })
    repo = await createFixtureRepo()
    await repo.commit({ 'a.txt': 'a\n', 'b.txt': 'b\n' }, 'init')
    projectId = (await server.call('POST', routes.projects(), { path: repo.path, defaultBase: 'main' })).body.project.id
    worktreeId = (await server.call('GET', routes.project(projectId))).body.worktrees[0].id
  })
  afterEach(async () => {
    await server.close()
    repo.cleanup()
  })

  it('drafts a commit from the project prompt, the branch and only the staged diff', async () => {
    await server.call('PATCH', routes.projectSettings(projectId), { drafts: { commitPrompt: 'Be terse.' } })
    repo.write({ 'a.txt': 'a changed\n', 'b.txt': 'b changed\n' })
    await server.call('POST', routes.stage(worktreeId), { stage: ['a.txt'] })

    const { status, body } = await server.call('POST', routes.draft(worktreeId), { kind: 'commit' })
    expect(status).toBe(200)
    expect(body).toEqual({ title: 'Change a', body: 'Because it needed changing.' })

    const [prompt = ''] = prompts
    expect(prompt.startsWith('Be terse.')).toBe(true)
    expect(prompt).toContain('Branch:\nmain')
    expect(prompt).toContain('+a changed')
    expect(prompt).not.toContain('b changed')
  })

  it('drafts a commit-all from every uncommitted change, staged or not, new files included', async () => {
    repo.write({ 'a.txt': 'a changed\n', 'fresh.txt': 'new\n' })

    expect((await server.call('POST', routes.draft(worktreeId), { kind: 'commitAll' })).status).toBe(200)
    const [prompt = ''] = prompts
    expect(prompt).toContain('+a changed')
    expect(prompt).toContain('New files:\nfresh.txt')
  })

  it('caps the new-file list and says how many it left out', async () => {
    repo.write(Object.fromEntries(Array.from({ length: 205 }, (_, i) => [`new-${String(i).padStart(3, '0')}.txt`, 'x\n'])))

    expect((await server.call('POST', routes.draft(worktreeId), { kind: 'commitAll' })).status).toBe(200)
    const [prompt = ''] = prompts
    expect(prompt).toContain('new-199.txt')
    expect(prompt).not.toContain('new-200.txt')
    expect(prompt).toContain('[5 more new files not listed]')
  })

  it('drafts a pull request from the commits and diff the branch adds over its base', async () => {
    await repo.branch('feature')
    await repo.git('checkout', '-q', 'feature')
    await repo.commit({ 'a.txt': 'a on feature\n' }, 'Rework a')
    repo.write({ 'b.txt': 'uncommitted\n' })

    const { status } = await server.call('POST', routes.draft(worktreeId), { kind: 'pullRequest', base: 'main' })
    expect(status).toBe(200)

    const [prompt = ''] = prompts
    expect(prompt).toContain('Write a GitHub pull request')
    expect(prompt).toContain('Branch:\nfeature')
    expect(prompt).toContain('- Rework a')
    expect(prompt).toContain('+a on feature')
    expect(prompt).not.toContain('uncommitted')
  })

  it('leaves a huge diff out and drafts from the commits and the file list', async () => {
    await repo.branch('feature')
    await repo.git('checkout', '-q', 'feature')
    await repo.commit({ 'huge.txt': Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n') }, 'Vendor a huge file')

    expect((await server.call('POST', routes.draft(worktreeId), { kind: 'pullRequest', base: 'main' })).status).toBe(200)
    const [prompt = ''] = prompts
    expect(prompt).toContain('- Vendor a huge file')
    expect(prompt).toContain('huge.txt')
    expect(prompt).toContain('[5000 changed lines, too many to include')
    expect(prompt).not.toContain('+line 42')
  })

  it('turns away requests without the token, and malformed ones', async () => {
    const anonymous = await server.app.inject({ method: 'POST', url: routes.draft(worktreeId), payload: { kind: 'commit' } })
    expect(anonymous.statusCode).toBe(401)
    for (const body of [{ kind: 'pullRequest' }, { kind: 'pullRequest', base: '--output=/tmp/x' }, { kind: 'poem' }]) {
      expect((await server.call('POST', routes.draft(worktreeId), body)).status).toBe(400)
    }
    expect(prompts).toHaveLength(0)
  })

  it('refuses when there is nothing to draft, without asking Claude', async () => {
    const { status, body } = await server.call('POST', routes.draft(worktreeId), { kind: 'commit' })
    expect(status).toBe(400)
    expect(body.error.code).toBe('nothing_to_draft')
    expect(prompts).toHaveLength(0)
  })
})
