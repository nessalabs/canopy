import { describe, expect, it } from 'vitest'

import { emptyEnvironment, type Project, type ServiceInfo, type Worktree, type WorktreeEnvironment } from '@canopy/shared'

import { isFailing, portUrl, trayGroups, trayPorts, traySummary } from '../src/lib/tray-model'

const project = (id: string, name: string): Project => ({
  id,
  name,
  path: `/repos/${name}`,
  defaultBase: 'main',
  hasCanopyYaml: true,
  config: { present: true, valid: true, errors: [], warnings: [], services: 1, ports: 1, databases: 0 },
  ecosystems: ['node'],
  createdAt: 0
})

const service = (name: string, patch: Partial<ServiceInfo> = {}): ServiceInfo => ({
  name,
  runtime: 'host',
  command: `npm run ${name}`,
  ports: [],
  status: 'healthy',
  restarts: 0,
  excluded: false,
  autostart: true,
  health: 'none',
  dependsOn: [],
  startedAt: 0,
  exitCode: null,
  lastError: null,
  ...patch
})

const worktree = (id: string, projectId: string, name: string, env: Partial<WorktreeEnvironment> = {}): Worktree => ({
  id,
  projectId,
  name,
  path: `/repos/${projectId}/${name}`,
  branch: name,
  baseBranch: 'main',
  isMain: false,
  managed: true,
  state: 'clean',
  status: null,
  environment: { ...emptyEnvironment(true), ...env }
})

describe('trayGroups', () => {
  const alpha = project('p1', 'alpha')
  const beta = project('p2', 'beta')

  it('drops worktrees Canopy has never provisioned, and projects left with none', () => {
    const groups = trayGroups(
      [alpha, beta],
      [worktree('w1', 'p1', 'feat', { state: 'stopped' }), worktree('w2', 'p1', 'fresh'), worktree('w3', 'p2', 'other')]
    )
    expect(groups.map((group) => group.project.id)).toEqual(['p1'])
    expect(groups[0].worktrees.map((w) => w.id)).toEqual(['w1'])
  })

  it('leads with running worktrees inside a project, then sorts by name', () => {
    const groups = trayGroups(
      [alpha],
      [
        worktree('w1', 'p1', 'zulu', { state: 'stopped' }),
        worktree('w2', 'p1', 'alfa', { state: 'stopped' }),
        worktree('w3', 'p1', 'yankee', { state: 'running' })
      ]
    )
    expect(groups[0].worktrees.map((w) => w.name)).toEqual(['yankee', 'alfa', 'zulu'])
  })

  it('leads with the project that has something running', () => {
    const groups = trayGroups(
      [alpha, beta],
      [worktree('w1', 'p1', 'idle', { state: 'stopped' }), worktree('w2', 'p2', 'busy', { state: 'running' })]
    )
    expect(groups.map((group) => group.project.name)).toEqual(['beta', 'alpha'])
  })
})

describe('traySummary', () => {
  it('counts states and totals the resources of running services only', () => {
    const summary = traySummary([
      worktree('w1', 'p1', 'a', { state: 'running', services: [service('web', { cpuPct: 4, memMb: 100 }), service('api', { cpuPct: 2, memMb: 50 })] }),
      worktree('w2', 'p1', 'b', { state: 'stopped', services: [service('web', { status: 'stopped', cpuPct: 9, memMb: 900 })] }),
      worktree('w3', 'p1', 'c', { state: 'degraded', services: [service('web', { status: 'unhealthy' })] })
    ])
    expect(summary).toEqual({ running: 2, stopped: 1, failing: 1, cpuPct: 6, memMb: 150, processes: 2 })
  })

  it('is all zeros with nothing provisioned', () => {
    expect(traySummary([])).toEqual({ running: 0, stopped: 0, failing: 0, cpuPct: 0, memMb: 0, processes: 0 })
  })
})

describe('isFailing', () => {
  it('flags a failed environment and a broken service under a running one', () => {
    expect(isFailing(worktree('w', 'p', 'a', { state: 'error' }))).toBe(true)
    expect(isFailing(worktree('w', 'p', 'a', { state: 'running', services: [service('web', { status: 'failed' })] }))).toBe(true)
  })

  it('ignores a broken service that is excluded, or one in a stopped environment', () => {
    expect(isFailing(worktree('w', 'p', 'a', { state: 'running', services: [service('web', { status: 'failed', excluded: true })] }))).toBe(false)
    expect(isFailing(worktree('w', 'p', 'a', { state: 'stopped', services: [service('web', { status: 'exited' })] }))).toBe(false)
  })
})

describe('trayPorts', () => {
  it('puts the primary service first and skips services with nothing listening', () => {
    const ports = trayPorts(
      worktree('w', 'p', 'a', {
        state: 'running',
        services: [
          service('api', { ports: [{ name: 'api', port: 40002 }] }),
          service('worker', { status: 'stopped', ports: [{ name: 'worker', port: 40003 }] }),
          service('web', { ports: [{ name: 'web', port: 40001 }] })
        ]
      })
    )
    expect(ports.map((port) => port.port)).toEqual([40001, 40002])
    expect(ports[0].primary).toBe(true)
    expect(ports[1].primary).toBe(false)
  })

  it('has nothing to open while the environment is stopped', () => {
    expect(trayPorts(worktree('w', 'p', 'a', { state: 'stopped', services: [service('web', { ports: [{ name: 'web', port: 1 }] })] }))).toEqual([])
  })
})

describe('portUrl', () => {
  it('points at loopback, where services bind', () => {
    expect(portUrl(40001)).toBe('http://localhost:40001')
  })
})
