import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { DatabaseSpec } from '@canopy/shared'

import { createMysqlAdapter, mysqlContainerName, mysqlTemplateFile } from '../../src/env/databases/mysql'
import { assertIdentifier, forkName, quoteIdentifier, quoteLiteral, slug, templateName } from '../../src/env/databases/naming'
import { createPostgresAdapter, pgContainerName, pgFixedPort } from '../../src/env/databases/postgres'
import { createRedisAdapter, redisContainerName } from '../../src/env/databases/redis'
import { createDbRegistry } from '../../src/env/databases/registry'
import { ApiError } from '../../src/lib/errors'
import type { ContainerSummary, DbContext, DockerHelper, LogSink } from '../../src/env/types'

// ---------- fakes ----------

function recordingSink(): LogSink & { lines: string[] } {
  const lines: string[] = []
  return { lines, out: (text) => lines.push(text), err: (text) => lines.push(text), sys: (text) => lines.push(text) }
}

interface FakeDocker extends DockerHelper {
  calls: string[][]
  /** Databases the emulated Postgres currently has. */
  databases: Set<string>
  containers: Set<string>
}

/**
 * A DockerHelper that emulates just enough of `docker exec … psql|mysqladmin|redis-cli` for the
 * adapters' control flow to be exercised: which statements they issue, in which order, and how
 * they react to a template that does or does not exist.
 */
function fakeDocker(options: { databases?: string[]; containers?: string[]; ps?: ContainerSummary[] } = {}): FakeDocker {
  const calls: string[][] = []
  const databases = new Set(options.databases ?? [])
  const containers = new Set(options.containers ?? [])
  const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 })
  const docker: FakeDocker = {
    calls,
    databases,
    containers,
    async info() {
      return { available: true, version: '27.0.0', path: '/usr/local/bin/docker' }
    },
    async run(args) {
      calls.push(args)
      if (args[0] === 'run') {
        const name = args[args.indexOf('--name') + 1]
        if (name) containers.add(name)
        return ok(`${name}-id\n`)
      }
      if (args[0] === 'exec') {
        const tool = args[2]
        const last = args[args.length - 1] ?? ''
        if (tool === 'psql') {
          const exists = /SELECT 1 FROM pg_database WHERE datname = '([^']+)'/.exec(last)
          if (exists) return ok(databases.has(exists[1] ?? '') ? '1' : '')
          const created = /^CREATE DATABASE "([^"]+)"/.exec(last)
          if (created) {
            databases.add(created[1] ?? '')
            return ok('CREATE DATABASE')
          }
          const dropped = /^DROP DATABASE IF EXISTS "([^"]+)"/.exec(last)
          if (dropped) {
            databases.delete(dropped[1] ?? '')
            return ok('DROP DATABASE')
          }
          if (last.includes('pg_database_size')) return ok('5242880')
          return ok('')
        }
        if (tool === 'pg_isready') return ok('accepting connections')
        if (tool === 'mysqladmin') return ok('mysqld is alive')
        if (tool === 'mysql') return ok('12.50')
        if (tool === 'mysqldump') return ok('-- dump\nCREATE TABLE t (id int);\n')
        if (tool === 'redis-cli') return ok('PONG')
        return ok('')
      }
      return ok('')
    },
    async stream(args, onLine) {
      calls.push(['stream', ...args])
      onLine('out', 'streamed')
      return { exitCode: 0 }
    },
    async ps() {
      return options.ps ?? []
    },
    async inspect(idOrName) {
      calls.push(['inspect', idOrName])
      if (!containers.has(idOrName)) return null
      return { State: { Running: true }, NetworkSettings: { Ports: { '5432/tcp': [{ HostPort: '54999' }], '3306/tcp': [{ HostPort: '33999' }] } } }
    },
    async remove(idOrName) {
      calls.push(['remove', idOrName])
      containers.delete(idOrName)
    },
    async stats() {
      return new Map()
    },
    async ensureImage(image) {
      calls.push(['ensureImage', image])
    },
    async ensureNetwork(name = 'canopy') {
      calls.push(['ensureNetwork', name])
      return name
    }
  }
  return docker
}

const spec = (partial: Partial<DatabaseSpec>): DatabaseSpec => ({ adapter: 'postgres', options: {}, ...partial })

// ---------- naming ----------

describe('database naming', () => {
  it('slugs anything into a safe identifier fragment', () => {
    expect(slug('Canopy App')).toBe('canopy_app')
    expect(slug('---weird...name---')).toBe('weird_name')
    expect(slug('')).toBe('x')
    expect(slug('a'.repeat(80))).toHaveLength(40)
  })

  it('names templates per project and forks per worktree', () => {
    expect(templateName('Canopy App', 'main-db')).toBe('tpl_canopy_app_main_db')
    expect(forkName('9f3c1d2e-1111-2222', 'main')).toBe('wt_9f3c1d2e_main')
    // Only the first eight characters of the uuid take part, so the name stays readable.
    expect(forkName('9f3c1d2e-9999-0000', 'main')).toBe(forkName('9f3c1d2e-1111-2222', 'main'))
  })

  it('rejects an identifier that could not have come from our helpers', () => {
    expect(assertIdentifier('tpl_app_main')).toBe('tpl_app_main')
    expect(() => assertIdentifier('drop"; DROP DATABASE x; --')).toThrow(ApiError)
    expect(() => quoteIdentifier('1bad')).toThrow(/unsafe database identifier/)
    expect(quoteLiteral("o'brien")).toBe("'o''brien'")
  })
})

// ---------- registry ----------

describe('adapter registry', () => {
  it('resolves every engine and refuses an unknown one', () => {
    const registry = createDbRegistry({ docker: fakeDocker(), dataRoot: '/data' })
    expect(registry.all().map((adapter) => adapter.adapter).sort()).toEqual(['mysql', 'postgres', 'redis', 'sqlite'])
    expect(registry.adapterFor('postgres').adapter).toBe('postgres')
    expect(registry.adapterFor('sqlite')).toBe(registry.adapterFor('sqlite'))
    expect(() => registry.adapterFor('mongo' as 'postgres')).toThrow(ApiError)
  })
})

// ---------- shared context ----------

describe('database adapters', () => {
  let root: string
  let logs: ReturnType<typeof recordingSink>
  let allocated: string[]

  const contextFor = (worktree: string, id = `${worktree.repeat(8)}-1111-2222`): DbContext => ({
    projectId: 'proj1234',
    projectName: 'Canopy App',
    projectPath: join(root, 'repo'),
    worktreeId: id,
    worktreeName: worktree,
  worktreeBranch: null,
    worktreePath: join(root, worktree),
    dataDir: join(root, 'data', worktree),
    logs,
    allocatePort: async (name) => {
      allocated.push(name)
      return 41234
    },
    env: { EXTRA: '1' }
  })

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'canopy-db-'))
    mkdirSync(join(root, 'repo'), { recursive: true })
    logs = recordingSink()
    allocated = []
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  // ---------- postgres ----------

  describe('postgres', () => {
    it('derives a stable host port from the engine version', () => {
      expect(pgFixedPort('16')).toBe(54316)
      expect(pgFixedPort('15')).toBe(54315)
      expect(pgFixedPort('16.2')).toBe(54316)
      const odd = pgFixedPort('latest')
      expect(odd).toBeGreaterThanOrEqual(54300)
      expect(odd).toBeLessThan(54400)
      expect(pgFixedPort('latest')).toBe(odd)
      expect(pgContainerName('16')).toBe('canopy-pg-16')
    })

    it('creates the shared container once, then builds the template', async () => {
      const docker = fakeDocker()
      const adapter = createPostgresAdapter(docker)
      const ctx = contextFor('a')

      await adapter.ensureSource('main', spec({ version: '16' }), ctx, { refresh: false })

      const runArgs = docker.calls.find((args) => args[0] === 'run') ?? []
      expect(runArgs).toContain('canopy-pg-16')
      expect(runArgs.join(' ')).toContain('-p 54316:5432')
      expect(runArgs.join(' ')).toContain('canopy.database=postgres')
      expect(runArgs.join(' ')).toContain('postgres:16')
      expect(docker.databases.has('tpl_canopy_app_main')).toBe(true)

      // A second database on the same engine reuses the container.
      docker.calls.length = 0
      await adapter.ensureSource('other', spec({ version: '16' }), ctx, { refresh: false })
      expect(docker.calls.some((args) => args[0] === 'run')).toBe(false)
    })

    it('reuses the published port of a container that already exists', async () => {
      const docker = fakeDocker({ containers: ['canopy-pg-16'] })
      const adapter = createPostgresAdapter(docker)
      const result = await adapter.fork('main', spec({ version: '16' }), contextFor('a'), 'empty')
      expect(result.detail).toMatchObject({ container: 'canopy-pg-16', database: 'wt_aaaaaaaa_main', port: '54999', host: '127.0.0.1', user: 'canopy' })
      expect(result.url).toBe('postgresql://canopy:canopy@127.0.0.1:54999/wt_aaaaaaaa_main')
    })

    it('leaves an existing template alone unless a refresh is asked for', async () => {
      const docker = fakeDocker({ containers: ['canopy-pg-16'], databases: ['tpl_canopy_app_main'] })
      const adapter = createPostgresAdapter(docker)
      const ctx = contextFor('a')

      await adapter.ensureSource('main', spec({ version: '16' }), ctx, { refresh: false })
      expect(docker.calls.some((args) => args.join(' ').includes('CREATE DATABASE'))).toBe(false)

      await adapter.ensureSource('main', spec({ version: '16' }), ctx, { refresh: true })
      const statements = docker.calls.map((args) => args[args.length - 1] ?? '')
      expect(statements.some((sql) => sql.includes('pg_terminate_backend'))).toBe(true)
      expect(statements.some((sql) => sql.startsWith('DROP DATABASE IF EXISTS "tpl_canopy_app_main"'))).toBe(true)
      expect(statements.some((sql) => sql.startsWith('CREATE DATABASE "tpl_canopy_app_main"'))).toBe(true)
    })

    it('restores a custom-format dump with pg_restore and a plain one with psql', async () => {
      const dump = join(root, 'repo', 'seed.dump')
      writeFileSync(dump, Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(16)]))
      const plain = join(root, 'repo', 'seed.sql')
      writeFileSync(plain, '-- plain\nCREATE TABLE t (id int);\n')
      const docker = fakeDocker({ containers: ['canopy-pg-16'] })
      const adapter = createPostgresAdapter(docker)

      await adapter.ensureSource('main', spec({ version: '16', seed: { dump: 'seed.dump' } }), contextFor('a'), { refresh: false })
      expect(docker.calls).toContainEqual(['cp', dump, 'canopy-pg-16:/tmp/canopy-seed-seed.dump'])
      expect(docker.calls.some((args) => args.includes('pg_restore') && args.includes('--no-owner'))).toBe(true)

      docker.calls.length = 0
      await adapter.ensureSource('two', spec({ version: '16', seed: { sql: 'seed.sql' } }), contextFor('a'), { refresh: false })
      expect(docker.calls.some((args) => args.includes('psql') && args.includes('-f'))).toBe(true)
      expect(docker.calls.some((args) => args.includes('pg_restore'))).toBe(false)
    })

    it('runs a seed command against the template with the url in the environment', async () => {
      const marker = join(root, 'seeded.txt')
      const docker = fakeDocker({ containers: ['canopy-pg-16'] })
      const adapter = createPostgresAdapter(docker)

      await adapter.ensureSource('main', spec({ version: '16', env: 'MAIN_URL', seed: { command: `printf '%s' "$MAIN_URL" > ${marker}; echo seeded` } }), contextFor('a'), { refresh: false })

      expect(readFileSync(marker, 'utf8')).toBe('postgresql://canopy:canopy@127.0.0.1:54999/tpl_canopy_app_main')
      expect(logs.lines).toContain('seeded')
    })

    it('surfaces a failing seed command as a db_postgres_failed ApiError', async () => {
      const adapter = createPostgresAdapter(fakeDocker({ containers: ['canopy-pg-16'] }))
      await expect(adapter.ensureSource('main', spec({ version: '16', seed: { command: 'exit 9' } }), contextFor('a'), { refresh: false })).rejects.toMatchObject({
        code: 'db_postgres_failed',
        status: 500
      })
    })

    it('forks with TEMPLATE, falls back to empty when the template is missing, and drops on destroy', async () => {
      const docker = fakeDocker({ containers: ['canopy-pg-16'], databases: ['tpl_canopy_app_main'] })
      const adapter = createPostgresAdapter(docker)
      const ctx = contextFor('a')

      const result = await adapter.fork('main', spec({ version: '16' }), ctx, 'template')
      const statements = docker.calls.map((args) => args[args.length - 1] ?? '')
      expect(statements.some((sql) => sql === 'CREATE DATABASE "wt_aaaaaaaa_main" TEMPLATE "tpl_canopy_app_main"')).toBe(true)
      expect(result.sizeMb).toBe(5)

      docker.calls.length = 0
      await adapter.fork('nope', spec({ version: '16' }), ctx, 'template')
      const plain = docker.calls.map((args) => args[args.length - 1] ?? '')
      expect(plain.some((sql) => sql === 'CREATE DATABASE "wt_aaaaaaaa_nope"')).toBe(true)
      expect(logs.lines.some((line) => line.includes('does not exist'))).toBe(true)

      await adapter.destroy('main', spec({ version: '16' }), ctx)
      expect(docker.databases.has('wt_aaaaaaaa_main')).toBe(false)
    })

    it('forks from another worktree by using its database as the template', async () => {
      const docker = fakeDocker({ containers: ['canopy-pg-16'], databases: ['wt_aaaaaaaa_main'] })
      const adapter = createPostgresAdapter(docker)
      const source = contextFor('a')

      await adapter.fork('main', spec({ version: '16' }), contextFor('b'), { fromWorktree: source.worktreeId }, source)

      const statements = docker.calls.map((args) => args[args.length - 1] ?? '')
      expect(statements.some((sql) => sql === 'CREATE DATABASE "wt_bbbbbbbb_main" TEMPLATE "wt_aaaaaaaa_main"')).toBe(true)
    })

    it('applies configured extensions to an empty fork', async () => {
      const docker = fakeDocker({ containers: ['canopy-pg-16'] })
      const adapter = createPostgresAdapter(docker)
      await adapter.fork('main', spec({ version: '16', options: { extensions: 'pgcrypto, vector' } }), contextFor('a'), 'empty')
      const statements = docker.calls.map((args) => args[args.length - 1] ?? '')
      expect(statements).toContain('CREATE EXTENSION IF NOT EXISTS "pgcrypto"')
      expect(statements).toContain('CREATE EXTENSION IF NOT EXISTS "vector"')
    })

    it('reports status and availability without throwing when the engine is down', async () => {
      const docker = fakeDocker({ containers: ['canopy-pg-16'] })
      const adapter = createPostgresAdapter(docker)
      expect(await adapter.status('main', spec({ version: '16' }), contextFor('a'))).toEqual({ ready: true, sizeMb: 5 })

      const dead = fakeDocker()
      dead.info = async () => ({ available: false, version: null, path: null })
      const downAdapter = createPostgresAdapter(dead)
      expect(await downAdapter.status('main', spec({ version: '16' }), contextFor('a'))).toEqual({ ready: false, sizeMb: null })
      expect(await downAdapter.available()).toMatchObject({ ok: false })
      await expect(downAdapter.destroy('main', spec({ version: '16' }), contextFor('a'))).resolves.toBeUndefined()
    })
  })

  // ---------- redis ----------

  describe('redis', () => {
    it('runs one container per worktree with its own port and appendonly volume', async () => {
      const docker = fakeDocker()
      const adapter = createRedisAdapter(docker)
      const ctx = contextFor('a')

      const result = await adapter.fork('cache', spec({ adapter: 'redis', version: '7' }), ctx, 'template')

      expect(allocated).toEqual(['db:cache'])
      const container = redisContainerName(ctx.worktreeId, 'cache')
      expect(container).toBe('canopy-redis-aaaaaaaa-cache')
      const runArgs = (docker.calls.find((args) => args[0] === 'run') ?? []).join(' ')
      expect(runArgs).toContain('-p 41234:6379')
      expect(runArgs).toContain(`-v ${join(root, 'data', 'a', 'redis', 'cache')}:/data`)
      expect(runArgs).toContain('redis-server --appendonly yes --dir /data')
      expect(runArgs).toContain(`canopy.worktree=${ctx.worktreeId}`)
      expect(result).toEqual({ url: 'redis://127.0.0.1:41234/0', sourceDatabase: null, detail: { port: '41234', container }, sizeMb: null })
    })

    it('copies the appendonly directory when forking from another worktree', async () => {
      const docker = fakeDocker()
      const adapter = createRedisAdapter(docker)
      const source = contextFor('a')
      mkdirSync(join(root, 'data', 'a', 'redis', 'cache'), { recursive: true })
      writeFileSync(join(root, 'data', 'a', 'redis', 'cache', 'appendonly.aof'), 'DATA')

      await adapter.fork('cache', spec({ adapter: 'redis' }), contextFor('b'), { fromWorktree: source.worktreeId }, source)

      expect(readFileSync(join(root, 'data', 'b', 'redis', 'cache', 'appendonly.aof'), 'utf8')).toBe('DATA')
    })

    it('destroy removes the container and the data directory', async () => {
      const docker = fakeDocker()
      const adapter = createRedisAdapter(docker)
      const ctx = contextFor('a')
      await adapter.fork('cache', spec({ adapter: 'redis' }), ctx, 'empty')
      expect(existsSync(join(root, 'data', 'a', 'redis', 'cache'))).toBe(true)

      await adapter.destroy('cache', spec({ adapter: 'redis' }), ctx)

      expect(docker.calls).toContainEqual(['remove', redisContainerName(ctx.worktreeId, 'cache')])
      expect(existsSync(join(root, 'data', 'a', 'redis', 'cache'))).toBe(false)
    })

    it('status pings the server', async () => {
      const adapter = createRedisAdapter(fakeDocker())
      expect(await adapter.status('cache', spec({ adapter: 'redis' }), contextFor('a'))).toEqual({ ready: true, sizeMb: null })
    })
  })

  // ---------- mysql ----------

  describe('mysql', () => {
    it('materialises the template as a sql file next to the project', async () => {
      const dataRoot = join(root, 'dataroot')
      const docker = fakeDocker()
      const adapter = createMysqlAdapter(docker, dataRoot)
      writeFileSync(join(root, 'repo', 'seed.sql'), 'CREATE TABLE t (id int);')

      await adapter.ensureSource('main', spec({ adapter: 'mysql', seed: { sql: 'seed.sql' } }), contextFor('a'), { refresh: false })

      const template = mysqlTemplateFile(dataRoot, 'proj1234', 'main')
      expect(template).toBe(join(dataRoot, 'templates', 'proj1234', 'main.sql'))
      expect(readFileSync(template, 'utf8')).toBe('CREATE TABLE t (id int);')
    })

    it('builds the template from a seed command through a throwaway container', async () => {
      const dataRoot = join(root, 'dataroot')
      const docker = fakeDocker()
      const adapter = createMysqlAdapter(docker, dataRoot)

      await adapter.ensureSource('main', spec({ adapter: 'mysql', seed: { command: 'echo migrating' } }), contextFor('a'), { refresh: false })

      const temp = 'canopy-mysql-tpl-proj1234-main'
      expect(docker.calls.some((args) => args[0] === 'run' && args.includes(temp))).toBe(true)
      expect(docker.calls.some((args) => args[0] === 'run' && args.join(' ').includes('-p 0:3306'))).toBe(true)
      expect(docker.calls).toContainEqual(['remove', temp])
      expect(readFileSync(mysqlTemplateFile(dataRoot, 'proj1234', 'main'), 'utf8')).toContain('CREATE TABLE t (id int);')
      expect(logs.lines).toContain('migrating')
    })

    it('forks into a fresh container and replays the template file', async () => {
      const dataRoot = join(root, 'dataroot')
      mkdirSync(join(dataRoot, 'templates', 'proj1234'), { recursive: true })
      const template = mysqlTemplateFile(dataRoot, 'proj1234', 'main')
      writeFileSync(template, 'CREATE TABLE t (id int);')
      const docker = fakeDocker()
      const adapter = createMysqlAdapter(docker, dataRoot)
      const ctx = contextFor('a')

      const result = await adapter.fork('main', spec({ adapter: 'mysql', version: '8' }), ctx, 'template')

      const container = mysqlContainerName(ctx.worktreeId, 'main')
      expect(container).toBe('canopy-mysql-aaaaaaaa-main')
      const runArgs = (docker.calls.find((args) => args[0] === 'run') ?? []).join(' ')
      expect(runArgs).toContain('-p 41234:3306')
      expect(runArgs).toContain('MYSQL_ROOT_PASSWORD=canopy')
      expect(runArgs).toContain('mysql:8')
      expect(docker.calls).toContainEqual(['cp', template, `${container}:/tmp/canopy-seed.sql`])
      expect(docker.calls.some((args) => args.join(' ').includes('mysql -uroot -pcanopy app < /tmp/canopy-seed.sql'))).toBe(true)
      expect(result).toEqual({ url: 'mysql://root:canopy@127.0.0.1:41234/app', sourceDatabase: template, detail: { container, port: '41234', database: 'app' }, sizeMb: 12.5 })
    })

    it('forks from another worktree by dumping its container first', async () => {
      const docker = fakeDocker()
      const adapter = createMysqlAdapter(docker, join(root, 'dataroot'))
      const source = contextFor('a')

      await adapter.fork('main', spec({ adapter: 'mysql' }), contextFor('b'), { fromWorktree: source.worktreeId }, source)

      expect(docker.calls.some((args) => args[0] === 'exec' && args[1] === mysqlContainerName(source.worktreeId, 'main') && args[2] === 'mysqldump')).toBe(true)
      expect(docker.calls.some((args) => args[0] === 'cp' && String(args[1]).includes('mysql-main-from-'))).toBe(true)
    })

    it('destroy removes the container with its volume, and status pings', async () => {
      const docker = fakeDocker()
      const adapter = createMysqlAdapter(docker, join(root, 'dataroot'))
      const ctx = contextFor('a')

      await adapter.destroy('main', spec({ adapter: 'mysql' }), ctx)
      expect(docker.calls).toContainEqual(['remove', mysqlContainerName(ctx.worktreeId, 'main')])
      expect(await adapter.status('main', spec({ adapter: 'mysql' }), ctx)).toEqual({ ready: true, sizeMb: 12.5 })
    })
  })
})
