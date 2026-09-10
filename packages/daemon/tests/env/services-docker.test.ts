import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ServiceSpec } from '@canopy/shared'

import { composeArgs, composeProjectName, composeUpArgs, createComposeRunner, envFileText } from '../../src/env/services/runners/compose'
import { containerName, createDockerRunner, dockerRunArgs, imageTag, inspectRunning, resolveVolume, shortId } from '../../src/env/services/runners/docker'
import type { ContainerSummary, DockerHelper, LogSink, ResolvedService, RunContext } from '../../src/env/types'

// ---------- fakes ----------

interface FakeDocker extends DockerHelper {
  calls: string[][]
  streams: string[][]
  aborted: string[][]
}

interface FakeOptions {
  runStdout?: (args: string[]) => string
  inspect?: (idOrName: string) => Record<string, unknown> | null
  ps?: ContainerSummary[]
}

function fakeDocker(options: FakeOptions = {}): FakeDocker {
  const calls: string[][] = []
  const streams: string[][] = []
  const aborted: string[][] = []
  return {
    calls,
    streams,
    aborted,
    async info() {
      return { available: true, version: '27.0.0', path: '/usr/local/bin/docker' }
    },
    async run(args) {
      calls.push(args)
      return { stdout: options.runStdout?.(args) ?? '', stderr: '', exitCode: 0 }
    },
    async stream(args, onLine, opts) {
      streams.push(args)
      // `docker wait` prints the container's exit code and returns, a build runs to completion;
      // `logs -f` and `compose up` stay attached until the caller aborts them, like the real CLI.
      if (args[0] === 'wait') {
        onLine('out', '17')
        return { exitCode: 0 }
      }
      onLine('out', `line from ${args[0]}`)
      if (args[0] !== 'logs' && args[0] !== 'compose') return { exitCode: 0 }
      return new Promise((resolve) => {
        opts?.signal?.addEventListener('abort', () => {
          aborted.push(args)
          resolve({ exitCode: 143 })
        })
      })
    },
    async ps(labels) {
      calls.push(['ps', JSON.stringify(labels)])
      return options.ps ?? []
    },
    async inspect(idOrName) {
      calls.push(['inspect', idOrName])
      return options.inspect ? options.inspect(idOrName) : null
    },
    async remove(idOrName) {
      calls.push(['remove', idOrName])
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
}

function recordingSink(): LogSink & { lines: string[] } {
  const lines: string[] = []
  return { lines, out: (text) => lines.push(`out ${text}`), err: (text) => lines.push(`err ${text}`), sys: (text) => lines.push(`sys ${text}`) }
}

const WORKTREE_ID = '9f3c1d2e-1111-2222-3333-444455556666'

const specOf = (partial: Partial<ServiceSpec> = {}): ServiceSpec => ({
  run: 'npm start',
  env: {},
  depends_on: [],
  restart: 'on-failure',
  autostart: true,
  stop_signal: 'SIGTERM',
  stop_timeout: '10s',
  ...partial
})

function service(name: string, partial: Partial<ResolvedService> = {}, spec: Partial<ServiceSpec> = {}): ResolvedService {
  return {
    name,
    spec: specOf(spec),
    runtime: 'docker',
    command: 'npm start',
    cwd: '/wt',
    env: {},
    ports: [],
    stopSignal: 'SIGTERM',
    stopTimeoutMs: 10_000,
    ...partial
  }
}

// ---------- pure argv ----------

describe('docker runner argv', () => {
  it('names and labels containers from the worktree id', () => {
    expect(shortId(WORKTREE_ID)).toBe('9f3c1d2e')
    expect(containerName(WORKTREE_ID, 'web')).toBe('canopy-9f3c1d2e-web')
    expect(containerName('!!weird id!!', 'my service')).toBe('canopy-weird-id-my-service')
    expect(imageTag('My App', 'web', 'abc123')).toBe('canopy/my-app-web:abc123')
  })

  it('builds the full run argv in a stable order', () => {
    const svc = service(
      'api',
      { env: { NODE_ENV: 'test', PORT: '41000' }, ports: [{ name: 'api', port: 41000 }], command: 'npm run dev' },
      { docker: { image: 'node:22', volumes: ['./cache:/cache', 'shared:/shared'], args: ['--cpus', '2'], user: '1000:1000', workdir: '/workspace' }, cwd: 'apps/api' }
    )

    expect(dockerRunArgs({ name: 'canopy-9f3c1d2e-api', image: 'node:22', worktreeId: WORKTREE_ID, worktreePath: '/wt', service: svc })).toEqual([
      'run',
      '-d',
      '--name',
      'canopy-9f3c1d2e-api',
      '--label',
      'canopy.managed=true',
      '--label',
      `canopy.worktree=${WORKTREE_ID}`,
      '--label',
      'canopy.service=api',
      '--network',
      'canopy',
      '-v',
      '/wt:/workspace',
      '-w',
      '/workspace/apps/api',
      '-e',
      'NODE_ENV=test',
      '-e',
      'PORT=41000',
      '-p',
      '41000:41000',
      '--user',
      '1000:1000',
      '-v',
      '/wt/cache:/cache',
      '-v',
      'shared:/shared',
      '--cpus',
      '2',
      'node:22',
      'sh',
      '-c',
      'npm run dev'
    ])
  })

  it('defaults the workdir and publishes the same port number on both sides', () => {
    const args = dockerRunArgs({
      name: 'c',
      image: 'i',
      worktreeId: 'w',
      worktreePath: '/wt',
      service: service('web', { ports: [{ name: 'web', port: 40001 }] }, { docker: { image: 'i', volumes: [], args: [], workdir: '/workspace' } })
    })
    expect(args).toContain('-p')
    expect(args[args.indexOf('-p') + 1]).toBe('40001:40001')
    expect(args[args.indexOf('-w') + 1]).toBe('/workspace')
  })

  it('resolves relative host volumes inside the worktree but leaves named volumes alone', () => {
    expect(resolveVolume('./data:/data', '/wt')).toBe('/wt/data:/data')
    expect(resolveVolume('sub/dir:/x:ro', '/wt')).toBe('/wt/sub/dir:/x:ro')
    expect(resolveVolume('/abs:/x', '/wt')).toBe('/abs:/x')
    expect(resolveVolume('pgdata:/var/lib/postgresql', '/wt')).toBe('pgdata:/var/lib/postgresql')
  })

  it('reads Running out of either inspect shape', () => {
    expect(inspectRunning(null)).toBe(false)
    expect(inspectRunning({ State: { Running: true } })).toBe(true)
    expect(inspectRunning([{ State: { Status: 'running' } }] as unknown as Record<string, unknown>)).toBe(true)
    expect(inspectRunning({ State: { Running: false } })).toBe(false)
  })
})

// ---------- docker runner ----------

describe('docker runner', () => {
  let logs: ReturnType<typeof recordingSink>
  let ctx: RunContext
  let workdir: string

  beforeEach(() => {
    logs = recordingSink()
    workdir = mkdtempSync(join(tmpdir(), 'canopy-docker-'))
    ctx = { worktreeId: WORKTREE_ID, worktreePath: workdir, projectName: 'canopy', dataDir: join(workdir, '.data'), logs }
  })
  afterEach(() => rmSync(workdir, { recursive: true, force: true }))

  it('ensures the network, clears a stale container, pulls, runs and follows the logs', async () => {
    const docker = fakeDocker({ runStdout: (args) => (args[0] === 'run' ? 'deadbeefcafe\n' : '') })
    const runner = createDockerRunner(docker)

    const handle = await runner.start(ctx, service('web', {}, { docker: { image: 'node:22', volumes: [], args: [], workdir: '/workspace' } }))

    expect(docker.calls[0]).toEqual(['ensureNetwork', 'canopy'])
    expect(docker.calls[1]).toEqual(['remove', 'canopy-9f3c1d2e-web'])
    expect(docker.calls[2]).toEqual(['ensureImage', 'node:22'])
    expect(handle).toMatchObject({ kind: 'docker', containerId: 'deadbeefcafe' })
    expect(docker.streams.some((args) => args.join(' ') === 'logs -f --tail 0 deadbeefcafe')).toBe(true)
    // `docker wait` printed 17, so that is the service's exit code.
    await expect(handle.exited).resolves.toEqual({ code: 17, signal: null })
    expect(docker.aborted.some((args) => args[0] === 'logs')).toBe(true)
  })

  it('builds a Dockerfile-backed image tagged with its content hash and reuses it', async () => {
    writeFileSync(join(workdir, 'Dockerfile'), 'FROM node:22\n')
    const hash = createHash('sha1').update('FROM node:22\n').digest('hex').slice(0, 12)
    const built = new Set<string>()
    const docker = fakeDocker({ runStdout: () => 'abc123\n', inspect: (id) => (built.has(id) ? { State: { Running: true } } : null) })
    const runner = createDockerRunner(docker)
    const svc = service('web', {}, { docker: { dockerfile: 'Dockerfile', volumes: [], args: [], workdir: '/workspace' } })

    await runner.start(ctx, svc)
    const buildArgs = docker.streams.find((args) => args[0] === 'build')
    expect(buildArgs).toEqual(['build', '-f', join(workdir, 'Dockerfile'), '-t', `canopy/canopy-web:${hash}`, workdir])

    built.add(`canopy/canopy-web:${hash}`)
    docker.streams.length = 0
    await runner.start(ctx, svc)
    expect(docker.streams.some((args) => args[0] === 'build')).toBe(false)
  })

  it('fails clearly when neither image nor dockerfile is configured', async () => {
    const runner = createDockerRunner(fakeDocker())
    await expect(runner.start(ctx, service('web'))).rejects.toThrow(/docker.image or docker.dockerfile/)
  })

  it('stop issues docker stop with the timeout in seconds, then removes', async () => {
    const docker = fakeDocker()
    const runner = createDockerRunner(docker)
    await runner.stop({ kind: 'docker', containerId: 'abc', exited: Promise.resolve({ code: 0, signal: null }) }, service('web', { stopTimeoutMs: 4500 }), ctx)

    expect(docker.calls).toContainEqual(['stop', '-t', '5', 'abc'])
    expect(docker.calls).toContainEqual(['remove', 'abc'])
  })

  it('alive follows the container state', async () => {
    const runner = createDockerRunner(fakeDocker({ inspect: (id) => (id === 'up' ? { State: { Running: true } } : { State: { Running: false } }) }))
    const handle = (id: string) => ({ kind: 'docker' as const, containerId: id, exited: new Promise<never>(() => {}) })
    expect(await runner.alive(handle('up'))).toBe(true)
    expect(await runner.alive(handle('down'))).toBe(false)
    expect(await runner.alive({ kind: 'docker', exited: new Promise<never>(() => {}) })).toBe(false)
  })

  it('reap removes the recorded container and anything still wearing our labels', async () => {
    const docker = fakeDocker({ ps: [{ id: 'left1', name: 'canopy-9f3c1d2e-web', image: 'node', state: 'exited', labels: {} }] })
    const runner = createDockerRunner(docker)

    await runner.reap(ctx, service('web'), { containerId: 'recorded' })

    expect(docker.calls).toContainEqual(['remove', 'recorded'])
    expect(docker.calls).toContainEqual(['ps', JSON.stringify({ 'canopy.worktree': WORKTREE_ID, 'canopy.service': 'web' })])
    expect(docker.calls).toContainEqual(['remove', 'left1'])
  })

  it('reap never throws when docker is unhappy', async () => {
    const docker = fakeDocker()
    docker.remove = async () => {
      throw new Error('docker daemon is not running')
    }
    await expect(createDockerRunner(docker).reap(ctx, service('web'), { containerId: 'x' })).resolves.toBeUndefined()
  })
})

// ---------- compose runner ----------

describe('compose runner', () => {
  let logs: ReturnType<typeof recordingSink>
  let ctx: RunContext
  let workdir: string
  const composeService = (partial: Partial<ServiceSpec['compose']> = {}) =>
    service('stack', { runtime: 'compose' }, { compose: { file: 'docker-compose.yml', services: [], profiles: [], ...partial } })

  beforeEach(() => {
    logs = recordingSink()
    workdir = mkdtempSync(join(tmpdir(), 'canopy-compose-'))
    ctx = { worktreeId: WORKTREE_ID, worktreePath: workdir, projectName: 'canopy', dataDir: join(workdir, '.data'), logs }
  })
  afterEach(() => rmSync(workdir, { recursive: true, force: true }))

  it('namespaces the project and composes the argv', () => {
    expect(composeProjectName(WORKTREE_ID, 'Stack')).toBe('canopy-9f3c1d2e-stack')
    expect(composeArgs({ project: 'p', file: '/wt/dc.yml', profiles: ['gpu'], envFile: '/data/e.env' }, 'stop', '-t', '10')).toEqual([
      'compose',
      '-p',
      'p',
      '-f',
      '/wt/dc.yml',
      '--profile',
      'gpu',
      '--env-file',
      '/data/e.env',
      'stop',
      '-t',
      '10'
    ])
    expect(composeUpArgs({ project: 'p', file: '/f', envFile: null }, ['web'])).toEqual(['compose', '-p', 'p', '-f', '/f', 'up', '--no-color', '--abort-on-container-exit=false', 'web'])
  })

  it('writes the resolved env as a dotenv file so ${VAR} in the compose file sees our ports', async () => {
    const docker = fakeDocker()
    const runner = createComposeRunner(docker)
    const svc = { ...composeService(), env: { API_PORT: '41000', GREETING: 'two\nlines' } }

    const handle = await runner.start(ctx, svc)

    expect(handle).toMatchObject({ kind: 'compose', composeProject: 'canopy-9f3c1d2e-stack' })
    expect(handle.pid).toBeUndefined()
    expect(readFileSync(join(ctx.dataDir, 'compose-stack.env'), 'utf8')).toBe('API_PORT=41000\nGREETING=two lines\n')
    expect(envFileText({ A: '1' })).toBe('A=1\n')
    expect(docker.streams[0]).toEqual([
      'compose',
      '-p',
      'canopy-9f3c1d2e-stack',
      '-f',
      join(workdir, 'docker-compose.yml'),
      '--env-file',
      join(ctx.dataDir, 'compose-stack.env'),
      'up',
      '--no-color',
      '--abort-on-container-exit=false'
    ])
    expect(logs.lines).toContain('out line from compose')
  })

  it('stop leaves the containers in place and detaches the up stream', async () => {
    const docker = fakeDocker()
    const runner = createComposeRunner(docker)
    const svc = composeService({ profiles: ['dev'], services: ['web'] })
    const handle = await runner.start(ctx, svc)

    await runner.stop(handle, svc, ctx)

    expect(docker.calls).toContainEqual([
      'compose',
      '-p',
      'canopy-9f3c1d2e-stack',
      '-f',
      join(workdir, 'docker-compose.yml'),
      '--profile',
      'dev',
      '--env-file',
      join(ctx.dataDir, 'compose-stack.env'),
      'stop',
      '-t',
      '10'
    ])
    expect(docker.aborted[0]?.[0]).toBe('compose')
    await expect(handle.exited).resolves.toEqual({ code: 143, signal: null })
  })

  it('alive asks compose for running containers', async () => {
    const docker = fakeDocker({ runStdout: (args) => (args.includes('ps') ? 'abc\n' : '') })
    const runner = createComposeRunner(docker)
    expect(await runner.alive({ kind: 'compose', composeProject: 'p', exited: new Promise<never>(() => {}) })).toBe(true)
    expect(docker.calls).toContainEqual(['compose', '-p', 'p', 'ps', '-q', '--status', 'running'])

    const empty = createComposeRunner(fakeDocker())
    expect(await empty.alive({ kind: 'compose', composeProject: 'p', exited: new Promise<never>(() => {}) })).toBe(false)
    expect(await empty.alive({ kind: 'compose', exited: new Promise<never>(() => {}) })).toBe(false)
  })

  it('reap takes the whole stack down with its volumes and never throws', async () => {
    const docker = fakeDocker()
    const runner = createComposeRunner(docker)
    const svc = composeService()

    await runner.reap(ctx, svc, { composeProject: 'canopy-9f3c1d2e-stack' })

    expect(docker.calls.some((args) => args.join(' ').includes('down -v --remove-orphans'))).toBe(true)

    const angry = fakeDocker()
    angry.run = async () => {
      throw new Error('no compose plugin')
    }
    await expect(createComposeRunner(angry).reap(ctx, svc, {})).resolves.toBeUndefined()
  })
})
