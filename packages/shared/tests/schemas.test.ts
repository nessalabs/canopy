import { describe, expect, it } from 'vitest'

import { AgentStreamEvent, CreateWorktreeInput, DiffSpec, Project } from '../src'

describe('shared schemas', () => {
  it('round-trips a project', () => {
    const project = {
      id: 'p1', name: 'acme', path: '/tmp/acme', defaultBase: 'main',
      hasCanopyYaml: false, ecosystems: ['node'], createdAt: 1
    }
    expect(Project.parse(project)).toEqual(project)
  })

  it('rejects worktree names git would choke on', () => {
    expect(CreateWorktreeInput.safeParse({ name: 'Feat X', branch: { mode: 'existing', name: 'x' } }).success).toBe(false)
    expect(CreateWorktreeInput.safeParse({ name: 'feat-x', branch: { mode: 'new', name: 'feat/x', base: 'main' } }).success).toBe(true)
  })

  it('discriminates diff specs and stream events', () => {
    expect(DiffSpec.parse({ kind: 'commit', sha: 'abc123' }).kind).toBe('commit')
    expect(AgentStreamEvent.safeParse({ type: 'nope' }).success).toBe(false)
  })
})
