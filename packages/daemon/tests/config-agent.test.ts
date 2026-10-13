import { describe, expect, it } from 'vitest'

import { emptyEnvironment, type ServiceInfo, type WorktreeEnvironment } from '@canopy/shared'

import { proposeConfig } from '../src/agents/config-agent'
import { checkConfig, type ConfigCheckDeps } from '../src/env/config-check'

const service = (name: string, status: ServiceInfo['status'], extra: Partial<ServiceInfo> = {}): ServiceInfo => ({
  name,
  runtime: 'host',
  command: 'npm run dev',
  ports: [],
  status,
  restarts: 0,
  excluded: false,
  autostart: true,
  health: 'tcp',
  dependsOn: [],
  startedAt: null,
  exitCode: null,
  lastError: null,
  ...extra
})

const env = (patch: Partial<WorktreeEnvironment>): WorktreeEnvironment => ({ ...emptyEnvironment(true), ...patch })

/** A daemon whose worktree walks through `states`, one per poll, and stays on the last. */
function fakeDeps(states: WorktreeEnvironment[], saved: string | null = 'version: 1\n') {
  const calls: string[] = []
  let clock = 0
  let polls = 0
  const deps: ConfigCheckDeps = {
    create: async (name, base) => {
      calls.push(`create ${name} from ${base}`)
      return { id: 'wt1', path: '/tmp/wt1' }
    },
    saved: () => saved,
    writeConfig: (path, raw) => calls.push(`write ${path} ${raw.trim()}`),
    provision: async (id) => void calls.push(`provision ${id}`),
    environment: () => states[Math.min(polls++, states.length - 1)]!,
    logTail: async (_id, stream) => [`${stream}: boom`],
    destroy: async (id) => void calls.push(`destroy ${id}`),
    sleep: async (ms) => void (clock += ms),
    now: () => clock
  }
  return { deps, calls }
}

describe('proposeConfig', () => {
  it('refuses a file that does not lint, naming the errors', async () => {
    const result = await proposeConfig({ yaml: 'name: x\n', summary: 'start' })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/version/)
  })

  it('accepts a valid file and tells the agent to wait for Save', async () => {
    const result = await proposeConfig({ yaml: 'version: 1\n', summary: 'start' })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]!.text).toMatch(/press Save/)
  })
})

describe('checkConfig', () => {
  it('copies the saved file in, provisions, reports healthy services and destroys the worktree', async () => {
    const healthy = env({ state: 'running', services: [service('web', 'healthy', { ports: [{ name: 'web', port: 41000 }] })] })
    const { deps, calls } = fakeDeps([env({ state: 'creating' }), env({ state: 'none' }), env({ state: 'provisioning' }), healthy])
    const report = await checkConfig(deps, 'main')
    expect(calls).toEqual([expect.stringMatching(/^create canopy-check-\w+ from main$/), 'write /tmp/wt1 version: 1', 'provision wt1', 'destroy wt1'])
    expect(report).toContain('✓ web (host) healthy on web=41000')
    expect(report).toContain('Verdict: 1/1 services healthy — all good.')
  })

  it('shows the log tail of a failed service', async () => {
    const failed = env({ state: 'degraded', services: [service('web', 'healthy'), service('api', 'failed', { exitCode: 1 })] })
    const { deps } = fakeDeps([env({ state: 'none' }), failed])
    const report = await checkConfig(deps, 'main')
    expect(report).toContain('✗ api (host) failed, exit 1')
    expect(report).toContain('Last log lines of api:\n      api: boom')
    expect(report).toContain('Verdict: 1/2 services healthy.')
  })

  it('does not provision when the worktree could not be created, and still destroys it', async () => {
    const { deps, calls } = fakeDeps([env({ state: 'error', stateReason: 'create-worktree: invalid reference: nope' })])
    const report = await checkConfig(deps, 'nope')
    expect(calls.some((call) => call.startsWith('provision'))).toBe(false)
    expect(calls.at(-1)).toBe('destroy wt1')
    expect(report).toContain('invalid reference: nope')
  })

  it('gives up at the deadline and says so', async () => {
    const { deps, calls } = fakeDeps([env({ state: 'none' }), env({ state: 'starting', services: [service('web', 'restarting')] })])
    const report = await checkConfig(deps, 'main')
    expect(report).toContain('Timed out after 10 minutes')
    expect(calls.at(-1)).toBe('destroy wt1')
  })

  it('has nothing to check without a saved file', async () => {
    const { deps, calls } = fakeDeps([], null)
    expect(await checkConfig(deps, 'main')).toMatch(/no saved canopy.yaml/)
    expect(calls).toEqual([])
  })
})
