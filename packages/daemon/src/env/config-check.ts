/**
 * Checking a canopy.yaml for real: a throwaway worktree from a base the user picked, provisioned
 * with the project's saved file and its services started, watched until each is healthy or has
 * failed, then destroyed. What comes back is a plain-text report the Canopy Agent reads.
 *
 * The saved file is copied in before provisioning because a worktree's own canopy.yaml wins over
 * the project's — a base that commits an older one would otherwise be checked instead.
 */
import type { ProvisionStep, ServiceInfo, ServiceStatus, WorktreeEnvironment } from '@canopy/shared'

export interface ConfigCheckDeps {
  /** Creates the worktree on a new branch from `base` without provisioning it; resolves with its id and path. */
  create(name: string, base: string): Promise<{ id: string; path: string }>
  /** The project's saved canopy.yaml, or null when there is none. */
  saved(): string | null
  writeConfig(worktreePath: string, raw: string): void
  /** Starts provisioning with the services started at the end. */
  provision(worktreeId: string): Promise<void>
  environment(worktreeId: string): WorktreeEnvironment
  /** The last lines of one log stream: `provision`, or a service's name. */
  logTail(worktreeId: string, stream: string): Promise<string[]>
  destroy(worktreeId: string): Promise<void>
  sleep(ms: number): Promise<void>
  now(): number
}

export const CHECK_TIMEOUT_MS = 10 * 60_000
const POLL_MS = 1000

const BUSY_STATES = new Set<WorktreeEnvironment['state']>(['creating', 'provisioning', 'starting'])
const BUSY_SERVICES = new Set<ServiceStatus>(['pending', 'starting', 'restarting'])

/** Whether there is still something to wait for: a step running, or a service on its way up. */
export const settling = (env: WorktreeEnvironment): boolean =>
  BUSY_STATES.has(env.state) || env.services.some((service) => !service.excluded && BUSY_SERVICES.has(service.status))

const STEP_MARK: Partial<Record<ProvisionStep['status'], string>> = { done: '✓', failed: '✗', skipped: '–' }

const stepLine = (step: ProvisionStep): string =>
  `  ${STEP_MARK[step.status] ?? '…'} ${step.name}${step.error ? ` — ${step.error}` : step.detail ? ` (${step.detail})` : ''}`

const ports = (service: ServiceInfo): string => (service.ports.length ? ` on ${service.ports.map((p) => `${p.name}=${p.port}`).join(', ')}` : '')

const serviceLine = (service: ServiceInfo): string => {
  const exit = service.exitCode !== null ? `, exit ${service.exitCode}` : ''
  const error = service.lastError ? ` — ${service.lastError}` : ''
  return `  ${service.status === 'healthy' ? '✓' : '✗'} ${service.name} (${service.runtime}) ${service.status}${exit}${ports(service)}${error}`
}

const indent = (lines: string[]): string[] => lines.map((line) => `      ${line}`)

export interface CheckOutcome {
  name: string
  base: string
  env: WorktreeEnvironment
  /** Log tails by stream, for the steps and services that failed. */
  tails: Record<string, string[]>
  timedOut: boolean
}

/** The report the agent reads: steps, services, the logs of what failed, and a one-line verdict. */
export function checkReport({ name, base, env, tails, timedOut }: CheckOutcome): string {
  const services = env.services.filter((service) => !service.excluded)
  const healthy = services.filter((service) => service.status === 'healthy').length
  const sections = [
    `Checked the saved canopy.yaml in throwaway worktree ${name}, from ${base}. It has been destroyed.`,
    ['Provisioning:', ...(env.provisioning?.steps ?? []).map(stepLine)].join('\n'),
    ['Services:', ...(services.length ? services.map(serviceLine) : ['  (none declared)'])].join('\n'),
    ...Object.entries(tails).map(([stream, lines]) => [`Last log lines of ${stream}:`, ...indent(lines)].join('\n')),
    timedOut ? `Timed out after ${CHECK_TIMEOUT_MS / 60_000} minutes still waiting on the steps or services above.` : null,
    env.stateReason ? `Worktree state: ${env.state} — ${env.stateReason}` : null,
    `Verdict: ${healthy}/${services.length} services healthy${healthy === services.length && env.state !== 'error' && !timedOut ? ' — all good.' : '.'}`
  ]
  return sections.filter((section): section is string => section !== null).join('\n\n')
}

/** The streams worth showing the agent: provisioning when a step failed, and every service that is not healthy. */
export function failedStreams(env: WorktreeEnvironment): string[] {
  const provision = env.provisioning?.steps.some((step) => step.status === 'failed') ? ['provision'] : []
  return [...provision, ...env.services.filter((service) => !service.excluded && service.status !== 'healthy').map((service) => service.name)]
}

/** A short name no other worktree has: `canopy-check-<base36 time>`. */
export const checkName = (now: number): string => `canopy-check-${now.toString(36)}`

/** Waits until `ready` holds or the deadline passes; true when it timed out. */
async function waitUntil(deps: ConfigCheckDeps, deadline: number, ready: () => boolean): Promise<boolean> {
  while (!ready()) {
    if (deps.now() > deadline) return true
    await deps.sleep(POLL_MS)
  }
  return false
}

/** Runs one check end to end. The worktree is destroyed whatever happens once it exists. */
export async function checkConfig(deps: ConfigCheckDeps, base: string): Promise<string> {
  const raw = deps.saved()
  if (raw === null) return 'There is no saved canopy.yaml to check. Propose one and ask the user to save it first.'
  const name = checkName(deps.now())
  const deadline = deps.now() + CHECK_TIMEOUT_MS
  const worktree = await deps.create(name, base)
  try {
    const settled = (): boolean => !settling(deps.environment(worktree.id))
    // Created without provisioning: the checkout and its copied files, then nothing to run yet.
    const stuck = await waitUntil(deps, deadline, settled)
    const created = !stuck && deps.environment(worktree.id).state !== 'error'
    if (created) {
      deps.writeConfig(worktree.path, raw)
      await deps.provision(worktree.id)
    }
    const timedOut = stuck || (created && (await waitUntil(deps, deadline, settled)))
    const env = deps.environment(worktree.id)
    const streams = failedStreams(env)
    const tails = Object.fromEntries(await Promise.all(streams.map(async (stream) => [stream, await deps.logTail(worktree.id, stream)] as const)))
    return checkReport({ name, base, env, tails, timedOut })
  } finally {
    await deps.destroy(worktree.id)
  }
}
