/**
 * The project's Canopy home (`~/.canopy/<project>/`): a canopy.yaml kept out of the repo, and
 * the guarantee that `configured` follows the file on disk rather than what was persisted the
 * first time the worktree was seen.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { routes, type Worktree } from '@canopy/shared'

import { createFixtureRepo, type FixtureRepo } from '../helpers/fixture-repo'
import { createTestServer, type TestServer } from '../helpers/test-server'

const yaml = (port: string): string => `version: 1
ports:
  ${port}: {}
services:
  web:
    run: node server.js
    env: { PORT: "\${ports.${port}}" }
`

describe('canopy.yaml in the project home', () => {
  let server: TestServer
  let repo: FixtureRepo
  let projectId: string
  let home: string

  const worktrees = async (): Promise<Worktree[]> => (await server.call('GET', routes.worktrees())).body.worktrees

  beforeEach(async () => {
    server = await createTestServer()
    repo = await createFixtureRepo()
    await repo.commit({ 'server.js': 'process.exit(0)\n' }, 'init')
    projectId = (await server.call('POST', routes.projects(), { path: repo.path })).body.project.id
    home = join(server.home, basename(repo.path))
    mkdirSync(home, { recursive: true })
  })
  afterEach(async () => {
    await server.close()
    repo.cleanup()
  })

  it('configures a project whose checkout carries no canopy.yaml', async () => {
    expect((await server.call('GET', routes.project(projectId))).body.project.hasCanopyYaml).toBe(false)
    expect((await worktrees())[0]?.environment.configured).toBe(false)

    writeFileSync(join(home, 'canopy.yaml'), yaml('web'))

    const project = (await server.call('GET', routes.project(projectId))).body.project
    expect(project.hasCanopyYaml).toBe(true)
    expect(project.config).toMatchObject({ present: true, valid: true, services: 1, ports: 1 })
    // The editor and the preview both resolve to the home file.
    expect((await server.call('GET', routes.projectConfig(projectId))).body.path).toBe(join(home, 'canopy.yaml'))
    expect((await server.call('GET', routes.projectEnvironment(projectId))).body.services[0]).toMatchObject({ name: 'web' })
    // …and the worktree can be started, without the daemon having been restarted.
    expect((await worktrees())[0]?.environment.configured).toBe(true)
  })

  it('saves a scaffolded file for a project that has none', async () => {
    const scaffold = await server.call('POST', routes.projectConfigScaffold(projectId))
    expect(scaffold.status).toBe(200)
    expect(scaffold.body.report.valid).toBe(true)

    const saved = await server.call('PUT', routes.projectConfig(projectId), { raw: yaml('web') })
    expect(saved.status).toBe(200)
    expect(saved.body.project.hasCanopyYaml).toBe(true)
    expect(readFileSync(join(repo.path, 'canopy.yaml'), 'utf8')).toBe(yaml('web'))
    expect((await server.call('GET', routes.projectConfig(projectId))).body.raw).toBe(yaml('web'))
  })

  it('lets the checkout win when both locations have a file', async () => {
    writeFileSync(join(home, 'canopy.yaml'), yaml('home'))
    await repo.commit({ 'canopy.yaml': yaml('repo') }, 'add config')

    const config = (await server.call('GET', routes.projectConfig(projectId))).body
    expect(config.path).toBe(join(repo.path, 'canopy.yaml'))
    expect((await server.call('GET', routes.projectEnvironment(projectId))).body.ports).toEqual([{ name: 'repo', preferred: null }])
  })

  it('re-reads configured when the file appears or disappears outside Canopy', async () => {
    expect((await worktrees())[0]?.environment.configured).toBe(false)

    // Written by hand, by an agent, or by a merge — not through PUT /projects/:id/config.
    repo.write({ 'canopy.yaml': yaml('web') })
    expect((await worktrees())[0]?.environment.configured).toBe(true)

    rmSync(join(repo.path, 'canopy.yaml'))
    expect((await worktrees())[0]?.environment.configured).toBe(false)
  })

  it('surfaces the errors of a broken file the same way', async () => {
    repo.write({ 'canopy.yaml': 'version: 1\nservices:\n  web:\n    run: echo ${ports.nope}\n' })
    const env = (await worktrees())[0]?.environment
    expect(env?.configured).toBe(false)
    expect(env?.configErrors.join(' ')).toContain('unknown port')
  })
})
