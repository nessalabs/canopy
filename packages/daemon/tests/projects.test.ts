import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { routes } from '@canopy/shared'

import { createFixtureRepo, type FixtureRepo } from './helpers/fixture-repo'
import { createTestServer, type TestServer } from './helpers/test-server'

describe('projects', () => {
  let server: TestServer
  let repo: FixtureRepo
  beforeEach(async () => {
    server = await createTestServer()
    repo = await createFixtureRepo()
    await repo.commit({ 'package.json': '{}', 'docker-compose.yml': 'services:\n  db: {}\n  redis: {}\n', 'canopy.yaml': 'version: 2\n' }, 'init')
  })
  afterEach(async () => {
    await server.close()
    repo.cleanup()
  })

  it('rejects non-repos and requires auth', async () => {
    expect((await server.call('POST', routes.scanProject(), { path: server.home })).status).toBe(400)
    const unauthenticated = await server.app.inject({ method: 'GET', url: routes.projects() })
    expect(unauthenticated.statusCode).toBe(401)
    expect((await server.app.inject({ method: 'GET', url: routes.healthz() })).statusCode).toBe(200)
  })

  it('scans ecosystems, compose services and canopy.yaml validity', async () => {
    const { body } = await server.call('POST', routes.scanProject(), { path: repo.path })
    expect(body.defaultBranch).toBe('main')
    expect(body.ecosystems).toEqual(['node', 'docker-compose'])
    expect(body.compose).toEqual({ file: 'docker-compose.yml', services: ['db', 'redis'] })
    expect(body.canopyYaml).toMatchObject({ present: true, valid: false })
    expect(body.canopyYaml.errors[0]).toContain('version')
  })

  it('adds once, lists, updates and removes', async () => {
    const added = await server.call('POST', routes.projects(), { path: repo.path })
    expect(added.status).toBe(201)
    expect(added.body.project).toMatchObject({ name: repo.path.split('/').pop(), defaultBase: 'main', hasCanopyYaml: true })
    expect((await server.call('POST', routes.projects(), { path: repo.path })).status).toBe(409)

    const id = added.body.project.id
    const updated = await server.call('PATCH', routes.project(id), { name: 'renamed' })
    expect(updated.body.project.name).toBe('renamed')
    expect((await server.call('GET', routes.branches(id))).body.branches.map((b: { name: string }) => b.name)).toEqual(['main'])
    expect((await server.call('DELETE', routes.project(id))).status).toBe(204)
    expect((await server.call('GET', routes.projects())).body.projects).toEqual([])
  })
})
