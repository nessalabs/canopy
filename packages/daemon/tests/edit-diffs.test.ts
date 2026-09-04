import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createFixtureRepo, type FixtureRepo } from './helpers/fixture-repo'
import { createTestServer, type TestServer } from './helpers/test-server'

const hook = (event: 'PreToolUse' | 'PostToolUse', cwd: string, toolUseId: string, input: unknown) => ({
  hook_event_name: event,
  session_id: 'sess-1',
  cwd,
  tool_name: 'Bash',
  tool_use_id: toolUseId,
  tool_input: input,
  transcript_path: '/ignored'
})

describe('edit diffs from hooks', () => {
  let server: TestServer
  let repo: FixtureRepo
  let worktreeId: string

  beforeEach(async () => {
    server = await createTestServer()
    repo = await createFixtureRepo()
    await repo.commit({ 'src/a.ts': 'export const a = 1\n', 'README.md': '# Demo\n' }, 'init')
    const { body } = await server.call('POST', '/api/v1/projects', { path: repo.path })
    const project = await server.call('GET', `/api/v1/projects/${body.project.id}`)
    worktreeId = project.body.worktrees[0].id
  })
  afterEach(async () => {
    await server.close()
    repo.cleanup()
  })

  it('records the files a tool call changed, with trees that diff exactly', async () => {
    const input = { command: 'echo x > src/a.ts' }
    expect((await server.call('POST', '/api/v1/hooks/claude', hook('PreToolUse', repo.path, 'tu-1', input))).status).toBe(204)
    writeFileSync(join(repo.path, 'src/a.ts'), 'export const a = 2\n')
    writeFileSync(join(repo.path, 'src/new.ts'), 'new\n')
    expect((await server.call('POST', '/api/v1/hooks/claude', hook('PostToolUse', repo.path, 'tu-1', input))).status).toBe(204)

    const { body } = await server.call('GET', '/api/v1/agent/sessions/claude/sess-1/edits')
    expect(body.edits.map((e: { path: string; attributed: boolean }) => [e.path, e.attributed])).toEqual([
      ['src/a.ts', true],
      ['src/new.ts', false]
    ])
    const [edit] = body.edits
    expect(edit.toolUseId).toBe('tu-1')
    expect(edit.worktreeId).toBe(worktreeId)

    const trees = await server.call('GET', `/api/v1/worktrees/${worktreeId}/trees/${edit.beforeTree}/${edit.afterTree}`)
    expect(trees.body.files.map((f: { path: string; status: string }) => `${f.status} ${f.path}`)).toEqual(['M src/a.ts', 'A src/new.ts'])
    const patch = await server.call('GET', `/api/v1/worktrees/${worktreeId}/trees/${edit.beforeTree}/${edit.afterTree}/file?path=src/a.ts`)
    expect(patch.body.patch).toContain('-export const a = 1')
    expect(patch.body.patch).toContain('+export const a = 2')

    // Later edits do not disturb the recorded diff: the trees are pinned by refs.
    writeFileSync(join(repo.path, 'src/a.ts'), 'export const a = 3\n')
    expect((await repo.git('for-each-ref', 'refs/canopy/snapshots/')).split('\n').filter(Boolean)).toHaveLength(2)
    const again = await server.call('GET', `/api/v1/worktrees/${worktreeId}/trees/${edit.beforeTree}/${edit.afterTree}/file?path=src/a.ts`)
    expect(again.body.patch).toBe(patch.body.patch)
  })

  it('stores nothing for a call that changed nothing, or ran outside a managed worktree', async () => {
    await server.call('POST', '/api/v1/hooks/claude', hook('PreToolUse', repo.path, 'tu-2', { command: 'ls' }))
    await server.call('POST', '/api/v1/hooks/claude', hook('PostToolUse', repo.path, 'tu-2', { command: 'ls' }))
    await server.call('POST', '/api/v1/hooks/claude', hook('PreToolUse', '/somewhere/else', 'tu-3', { command: 'ls' }))
    await server.call('POST', '/api/v1/hooks/claude', hook('PostToolUse', '/somewhere/else', 'tu-3', { command: 'ls' }))
    const { body } = await server.call('GET', '/api/v1/agent/sessions/claude/sess-1/edits')
    expect(body.edits).toEqual([])
  })

  it('rejects a malformed hook payload with 400', async () => {
    expect((await server.call('POST', '/api/v1/hooks/claude', { hook_event_name: 'Stop' })).status).toBe(400)
  })
})
