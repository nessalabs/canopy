import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { routes } from '@canopy/shared'

import { createTestServer, type TestServer } from './helpers/test-server'

describe('GET /fs/dirs', () => {
  let server: TestServer
  let root: string
  beforeEach(async () => {
    server = await createTestServer()
    root = realpathSync(mkdtempSync(join(tmpdir(), 'canopy-fs-')))
    mkdirSync(join(root, 'repo', '.git'), { recursive: true })
    mkdirSync(join(root, 'plain'))
    mkdirSync(join(root, '.hidden'))
    writeFileSync(join(root, 'file.txt'), 'x')
    symlinkSync(join(root, 'plain'), join(root, 'link-to-plain'))
  })
  afterEach(async () => {
    await server.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('lists folders then files, marks git repos, hides dotfiles unless asked', async () => {
    const { status, body } = await server.call('GET', `${routes.fsDirs()}?path=${encodeURIComponent(root)}`)
    expect(status).toBe(200)
    expect(body.path).toBe(root)
    expect(body.parent).toBe(join(root, '..').replace(/\/[^/]+\/\.\.$/, '') || body.parent)
    expect(body.isGitRepo).toBe(false)
    expect(body.entries.map((e: { name: string; kind: string }) => `${e.kind}:${e.name}`)).toEqual(['dir:link-to-plain', 'dir:plain', 'dir:repo', 'file:file.txt'])
    expect(body.entries.find((e: { name: string }) => e.name === 'repo').isGitRepo).toBe(true)
    expect(body.truncated).toBe(false)

    const withHidden = await server.call('GET', `${routes.fsDirs()}?path=${encodeURIComponent(root)}&hidden=1`)
    expect(withHidden.body.entries.map((e: { name: string }) => e.name)).toEqual(['link-to-plain', 'plain', 'repo', '.hidden', 'file.txt'])
  })

  it('defaults to home, expands ~, and reports missing paths', async () => {
    const home = await server.call('GET', routes.fsDirs())
    expect(home.body.path).toBe(homedir())
    expect(home.body.home).toBe(homedir())
    const tilde = await server.call('GET', `${routes.fsDirs()}?path=~`)
    expect(tilde.body.path).toBe(homedir())

    const missing = await server.call('GET', `${routes.fsDirs()}?path=${encodeURIComponent(join(root, 'nope'))}`)
    expect(missing.status).toBe(400)
    expect(missing.body.error.code).toBe('path_not_found')
    const file = await server.call('GET', `${routes.fsDirs()}?path=${encodeURIComponent(join(root, 'file.txt'))}`)
    expect(file.body.error.code).toBe('not_a_directory')
    const rootListing = await server.call('GET', `${routes.fsDirs()}?path=/`)
    expect(rootListing.body.parent).toBeNull()
  })
})
