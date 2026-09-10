import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type CanopyConfig, DEFAULT_WORKTREE_OPTIONS, defaultProjectSettings, parseCanopyYaml, type WorktreeOptions } from '@canopy/shared'

import { dbEnvKey, envFileText, resolveEnvironment, type ResolveInput, writeEnvFile } from '../../src/env/config/resolve'

const YAML = `version: 1
defaults:
  env:
    LOG_LEVEL: debug
    API_URL: http://localhost:\${ports.api}
env:
  LOG_LEVEL: info
ports:
  web: {}
  api: {}
databases:
  main:
    adapter: postgres
    env: DATABASE_URL
setup:
  - npm ci
  - run: npm run migrate
    cwd: server
    env:
      DB: \${db.main.url}
    if_changed: [prisma/schema.prisma]
services:
  api:
    run: node server.js
    cwd: server
    env:
      PORT: "\${ports.api}"
    stop_signal: SIGINT
    stop_timeout: 3s
  web:
    run: npm run dev -- --port \${ports.web}
    depends_on: [api]
  worker:
    run: node worker.js
    runtime: docker
    docker: { image: node:22 }
  bare:
    run: node bare.js
`

const config = (): CanopyConfig => {
  const parsed = parseCanopyYaml(YAML)
  expect(parsed.errors).toEqual([])
  return parsed.config as CanopyConfig
}

const input = (patch: Partial<ResolveInput> = {}): ResolveInput => ({
  config: config(),
  options: { ...DEFAULT_WORKTREE_OPTIONS },
  settings: defaultProjectSettings(),
  ports: { web: 40010, api: 40011 },
  databases: [{ name: 'main', url: 'postgres://canopy:s3cret@127.0.0.1:5432/wt1_main', envKey: 'DATABASE_URL' }],
  worktree: { id: 'wt1', name: 'feat-x', path: '/tmp/wt1', branch: 'feat/x' },
  project: { id: 'p1', name: 'proj' },
  ...patch
})

describe('resolveEnvironment', () => {
  it('layers canopy, yaml, db, project and override in that order', () => {
    const settings = defaultProjectSettings()
    settings.defaults.env = [{ key: 'LOG_LEVEL', value: 'warn' }, { key: 'PROJECT_ONLY', value: 'yes' }]
    const options: WorktreeOptions = { ...DEFAULT_WORKTREE_OPTIONS, env: [{ key: 'LOG_LEVEL', value: 'trace' }] }
    const resolved = resolveEnvironment(input({ settings, options }))
    const byKey = Object.fromEntries(resolved.env.map((entry) => [entry.key, entry]))

    expect(byKey['LOG_LEVEL']).toMatchObject({ value: 'trace', source: 'override' })
    expect(byKey['PROJECT_ONLY']).toMatchObject({ value: 'yes', source: 'project' })
    expect(byKey['DATABASE_URL']).toMatchObject({ source: 'db', secret: true })
    expect(byKey['CANOPY_WORKTREE']).toMatchObject({ value: 'feat-x', source: 'canopy' })
    expect(byKey['CANOPY_BRANCH']?.value).toBe('feat/x')
    expect(byKey['CANOPY_PORT_WEB']?.value).toBe('40010')
    expect(byKey['CANOPY_DB_MAIN_URL']?.value).toContain('postgres://')
    // Ports never set PORT on their own; a service asks for it explicitly.
    expect(byKey['PORT']).toBeUndefined()
    expect(resolved.envMap['LOG_LEVEL']).toBe('trace')
  })

  it('interpolates ports and db urls, including inside yaml defaults', () => {
    const resolved = resolveEnvironment(input())
    expect(resolved.envMap['API_URL']).toBe('http://localhost:40011')
    expect(resolved.scope['ports']).toEqual({ web: '40010', api: '40011' })
    expect(resolved.scope['db']?.['main.url']).toContain('wt1_main')
    expect(resolved.scope['worktree']?.['path']).toBe('/tmp/wt1')
  })

  it('marks secrets by key convention, by credentials in the value and by explicit flag', () => {
    const settings = defaultProjectSettings()
    settings.defaults.env = [
      { key: 'STRIPE_SECRET_KEY', value: 'sk_test' },
      { key: 'MYSQL_DSN', value: 'mysql://root:hunter2@localhost/db' },
      { key: 'PLAIN', value: 'nothing' },
      { key: 'API_TOKEN', value: 'x', secret: false }
    ]
    const secretByKey = Object.fromEntries(resolveEnvironment(input({ settings })).env.map((entry) => [entry.key, entry.secret]))
    expect(secretByKey['STRIPE_SECRET_KEY']).toBe(true)
    expect(secretByKey['MYSQL_DSN']).toBe(true)
    expect(secretByKey['PLAIN']).toBe(false)
    expect(secretByKey['API_TOKEN']).toBe(false)
  })

  it('resolves services in start order with commands, cwd, ports and stop settings', () => {
    const resolved = resolveEnvironment(input())
    expect(resolved.services.map((service) => service.name)).toEqual(['api', 'web', 'worker', 'bare'])

    const api = resolved.services.find((service) => service.name === 'api')!
    expect(api.command).toBe('node server.js')
    expect(api.cwd).toBe(join('/tmp/wt1', 'server'))
    expect(api.env['PORT']).toBe('40011')
    expect(api.env['LOG_LEVEL']).toBe('info')
    expect(api.ports).toEqual([{ name: 'api', port: 40011 }])
    expect(api.stopSignal).toBe('SIGINT')
    expect(api.stopTimeoutMs).toBe(3000)

    const web = resolved.services.find((service) => service.name === 'web')!
    expect(web.command).toBe('npm run dev -- --port 40010')
    expect(web.runtime).toBe('host')
    expect(resolved.services.find((service) => service.name === 'worker')?.runtime).toBe('docker')
  })

  it('lists excluded services but marks them, and resolves setup steps', () => {
    const options: WorktreeOptions = { ...DEFAULT_WORKTREE_OPTIONS, services: ['api'] }
    const resolved = resolveEnvironment(input({ options }))
    expect(resolved.services.map((service) => service.name)).toEqual(['api', 'web', 'worker', 'bare'])
    expect([...resolved.excluded].sort()).toEqual(['bare', 'web', 'worker'])

    expect(resolved.setup).toHaveLength(2)
    expect(resolved.setup[0]).toMatchObject({ name: 'step 1', run: 'npm ci', cwd: '/tmp/wt1', if_changed: undefined })
    expect(resolved.setup[1]).toMatchObject({ run: 'npm run migrate', cwd: join('/tmp/wt1', 'server'), if_changed: ['prisma/schema.prisma'] })
    expect(resolved.setup[1]?.env['DB']).toContain('wt1_main')
  })

  it('forces a runtime, but keeps a service on the host when docker has no image', () => {
    const options: WorktreeOptions = { ...DEFAULT_WORKTREE_OPTIONS, runtime: 'docker' }
    const resolved = resolveEnvironment(input({ options }))
    const runtimes = Object.fromEntries(resolved.services.map((service) => [service.name, service.runtime]))
    expect(runtimes['worker']).toBe('docker')
    expect(runtimes['web']).toBe('host')
    expect(resolved.notes.join(' ')).toContain('services.web')

    const host: WorktreeOptions = { ...DEFAULT_WORKTREE_OPTIONS, runtime: 'host' }
    expect(resolveEnvironment(input({ options: host })).services.find((service) => service.name === 'worker')?.runtime).toBe('host')

    const settings = defaultProjectSettings()
    settings.defaults.runtime = 'docker'
    expect(resolveEnvironment(input({ settings })).services.find((service) => service.name === 'worker')?.runtime).toBe('docker')
  })

  it('resolves the env file path and honours env_file: false', () => {
    expect(resolveEnvironment(input()).envFile).toBe(join('/tmp/wt1', '.env.canopy'))
    const off = { ...config(), env_file: false as const }
    expect(resolveEnvironment(input({ config: off })).envFile).toBeNull()
  })

  it('leaves a database template unresolved until the fork exists', () => {
    const resolved = resolveEnvironment(input({ databases: [{ name: 'main', url: null, envKey: 'DATABASE_URL' }] }))
    expect(resolved.envMap['DATABASE_URL']).toBeUndefined()
    expect(resolved.setup[1]?.env['DB']).toBe('${db.main.url}')
  })
})

describe('dotenv output', () => {
  let root: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'canopy-env-')))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('quotes only what needs quoting and escapes backslashes and quotes', () => {
    const text = envFileText([
      { key: 'PLAIN', value: 'value', source: 'yaml', secret: false },
      { key: 'SPACED', value: 'a b', source: 'yaml', secret: false },
      { key: 'HASHED', value: 'a#b', source: 'yaml', secret: false },
      { key: 'QUOTED', value: 'say "hi"\\here', source: 'yaml', secret: false },
      { key: 'EMPTY', value: '', source: 'yaml', secret: false }
    ])
    expect(text.split('\n')).toEqual([
      '# generated by canopy — do not edit',
      'PLAIN=value',
      'SPACED="a b"',
      'HASHED="a#b"',
      'QUOTED="say \\"hi\\"\\\\here"',
      'EMPTY=""',
      ''
    ])
  })

  it('writes the file, creating directories as needed', () => {
    const path = join(root, 'nested', '.env.canopy')
    writeEnvFile(path, [{ key: 'A', value: '1', source: 'canopy', secret: false }])
    expect(readFileSync(path, 'utf8')).toBe('# generated by canopy — do not edit\nA=1\n')
  })
})

describe('dbEnvKey', () => {
  it('uses the spec key or upper-snakes the name', () => {
    expect(dbEnvKey('main', {})).toBe('MAIN_URL')
    expect(dbEnvKey('read-replica', {})).toBe('READ_REPLICA_URL')
    expect(dbEnvKey('main', { env: 'DATABASE_URL' })).toBe('DATABASE_URL')
  })
})
