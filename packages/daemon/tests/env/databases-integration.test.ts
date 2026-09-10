/**
 * Real-engine tests. They start containers, so they only run with CANOPY_TEST_DOCKER=1:
 *
 *   CANOPY_TEST_DOCKER=1 npx vitest run tests/env/databases-integration.test.ts
 *
 * They deliberately use a randomised project name so the databases they create cannot collide
 * with a running daemon's, and they leave the shared `canopy-pg-16` container in place (that
 * container is meant to outlive any single worktree) while dropping every database they made.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { DatabaseSpec } from '@canopy/shared'

import { createDocker } from '../../src/env/docker'
import { forkName, templateName } from '../../src/env/databases/naming'
import { createPostgresAdapter, pgContainerName } from '../../src/env/databases/postgres'
import { createRedisAdapter, redisContainerName } from '../../src/env/databases/redis'
import type { DbContext, LogSink } from '../../src/env/types'

const enabled = process.env.CANOPY_TEST_DOCKER === '1'
const MINUTES = 5 * 60_000

const sink = (): LogSink => ({ out: () => {}, err: () => {}, sys: () => {} })
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

describe.skipIf(!enabled)('docker-backed database adapters', () => {
  const docker = createDocker()
  const suffix = Math.random().toString(36).slice(2, 8)
  const projectName = `canopy_it_${suffix}`
  let root: string

  const contextFor = (worktree: string): DbContext => ({
    projectId: `proj_${suffix}`,
    projectName,
    projectPath: join(root, 'repo'),
    worktreeId: `${worktree.repeat(8)}-${suffix}`,
    worktreeName: worktree,
  worktreeBranch: null,
    worktreePath: join(root, worktree),
    dataDir: join(root, 'data', worktree),
    logs: sink(),
    allocatePort: async () => 45000 + Math.floor(Math.random() * 900),
    env: {}
  })

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'canopy-it-'))
    rmSync(join(root, 'repo'), { recursive: true, force: true })
    writeFileSync(join(root, 'seed.sql'), '')
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it(
    'postgres: seeds a template, forks it, forks a fork, and drops everything',
    async () => {
      const { mkdirSync } = await import('node:fs')
      mkdirSync(join(root, 'repo'), { recursive: true })
      writeFileSync(join(root, 'repo', 'seed.sql'), 'CREATE TABLE widgets (id int);\nINSERT INTO widgets VALUES (1);\n')
      const adapter = createPostgresAdapter(docker)
      const spec: DatabaseSpec = { adapter: 'postgres', version: '16', seed: { sql: 'seed.sql' }, options: {} }
      const container = pgContainerName('16')
      const a = contextFor('a')
      const b = contextFor('b')
      const count = async (database: string): Promise<string> =>
        (await docker.run(['exec', container, 'psql', '-U', 'canopy', '-d', database, '-tAc', 'SELECT count(*) FROM widgets'])).stdout.trim()

      await adapter.ensureSource('main', spec, a, { refresh: false })
      const forkA = await adapter.fork('main', spec, a, 'template')

      expect(forkA.url).toContain(forkName(a.worktreeId, 'main'))
      expect(await count(forkName(a.worktreeId, 'main'))).toBe('1')
      expect((await adapter.status('main', spec, a)).ready).toBe(true)

      await docker.run(['exec', container, 'psql', '-U', 'canopy', '-d', forkName(a.worktreeId, 'main'), '-c', 'INSERT INTO widgets VALUES (2)'])
      await adapter.fork('main', spec, b, { fromWorktree: a.worktreeId }, a)
      expect(await count(forkName(b.worktreeId, 'main'))).toBe('2')

      await adapter.destroy('main', spec, a)
      await adapter.destroy('main', spec, b)
      expect((await adapter.status('main', spec, a)).ready).toBe(false)
      await docker.run(['exec', container, 'psql', '-U', 'canopy', '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${templateName(projectName, 'main')}`])
    },
    MINUTES
  )

  it(
    'redis: starts a per-worktree server, clones its data into another worktree, and destroys it',
    async () => {
      const adapter = createRedisAdapter(docker)
      const spec: DatabaseSpec = { adapter: 'redis', version: '7', options: {} }
      const a = contextFor('a')
      const b = contextFor('b')

      const forkA = await adapter.fork('cache', spec, a, 'template')
      expect(forkA.url).toMatch(/^redis:\/\/127\.0\.0\.1:\d+\/0$/)
      expect((await adapter.status('cache', spec, a)).ready).toBe(true)

      const containerA = redisContainerName(a.worktreeId, 'cache')
      await docker.run(['exec', containerA, 'redis-cli', 'set', 'canopy', 'hello'])
      // Force the appendonly files to disk so the copy below has something to load.
      await docker.run(['exec', containerA, 'redis-cli', 'bgrewriteaof'])
      await sleep(1500)

      await adapter.fork('cache', spec, b, { fromWorktree: a.worktreeId }, a)
      const containerB = redisContainerName(b.worktreeId, 'cache')
      let value = ''
      for (let attempt = 0; attempt < 10 && value !== 'hello'; attempt += 1) {
        value = (await docker.run(['exec', containerB, 'redis-cli', 'get', 'canopy'])).stdout.trim()
        if (value !== 'hello') await sleep(500)
      }
      expect(value).toBe('hello')

      await adapter.destroy('cache', spec, a)
      await adapter.destroy('cache', spec, b)
      expect(await docker.inspect(containerA)).toBeNull()
      expect((await adapter.status('cache', spec, b)).ready).toBe(false)
    },
    MINUTES
  )
})
