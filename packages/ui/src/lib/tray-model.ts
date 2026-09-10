/**
 * The menu-bar panel's view of the fleet: which projects are worth a row, in what order, and
 * the one-line rollups its header shows. Pure functions over the wire types — the panel stays
 * a rendering of these, and the ordering rules are unit-tested rather than argued about.
 */
import { isLive, primaryService, serviceResources, type Project, type ServiceInfo, type Worktree } from '@canopy/shared'

/** Service statuses that mean a running environment is not actually serving. */
const BROKEN: ServiceInfo['status'][] = ['unhealthy', 'exited', 'failed']

/** A worktree whose services are up but not all healthy, or whose environment itself failed. */
export function isFailing(worktree: Worktree): boolean {
  const env = worktree.environment
  if (env.state === 'error' || env.state === 'degraded') return true
  return isLive(env.state) && env.services.some((service) => !service.excluded && BROKEN.includes(service.status))
}

/** Live first, then anything provisioned; the panel leads with what is actually running. */
const rank = (worktree: Worktree): number => (isLive(worktree.environment.state) ? 0 : 1)

export interface TrayGroup {
  project: Project
  worktrees: Worktree[]
}

/**
 * Projects that have an environment Canopy knows about, each with its worktrees live-first.
 * Never-provisioned worktrees are left out: the panel answers "what is running", and the app
 * window is where the rest of the fleet is managed.
 */
export function trayGroups(projects: Project[], worktrees: Worktree[]): TrayGroup[] {
  const groups: TrayGroup[] = []
  for (const project of projects) {
    const owned = worktrees
      .filter((worktree) => worktree.projectId === project.id && worktree.environment.state !== 'none')
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    if (owned.length > 0) groups.push({ project, worktrees: owned })
  }
  return groups.sort((a, b) => rank(a.worktrees[0]) - rank(b.worktrees[0]) || a.project.name.localeCompare(b.project.name))
}

export interface TraySummary {
  running: number
  stopped: number
  /** Running environments that need attention — the reason to look at the menu bar at all. */
  failing: number
  /** CPU and memory across every service Canopy is supervising right now. */
  cpuPct: number
  memMb: number
  /** Supervised processes and containers behind those two figures. */
  processes: number
}

export function traySummary(worktrees: Worktree[]): TraySummary {
  const live = worktrees.filter((worktree) => isLive(worktree.environment.state))
  const totals = serviceResources(live.flatMap((worktree) => worktree.environment.services))
  return {
    running: live.length,
    stopped: worktrees.filter((worktree) => worktree.environment.state === 'stopped').length,
    failing: worktrees.filter(isFailing).length,
    cpuPct: totals.cpuPct,
    memMb: totals.memMb,
    processes: totals.processes
  }
}

export interface TrayPort {
  service: string
  /** The port's name in canopy.yaml (`web`, `api`), which is what the chip labels. */
  name: string
  port: number
  /** The one a "just open it" click should land on. */
  primary: boolean
}

/**
 * Every reachable port of a running worktree, the primary service's first. Excluded services
 * and services that are not up have nothing to open, so they contribute nothing.
 */
export function trayPorts(worktree: Worktree): TrayPort[] {
  const env = worktree.environment
  if (!isLive(env.state)) return []
  const featured = primaryService(env.services)
  const ports: TrayPort[] = []
  for (const service of env.services) {
    if (service.excluded || service.status === 'stopped' || service.status === 'pending') continue
    for (const [index, port] of service.ports.entries()) {
      ports.push({ service: service.name, name: port.name, port: port.port, primary: service === featured && index === 0 })
    }
  }
  return ports.sort((a, b) => Number(b.primary) - Number(a.primary))
}

/** The URL a port chip opens. Services bind loopback, so localhost is always the right host. */
export const portUrl = (port: number): string => `http://localhost:${port}`
