import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import type { TurnOptions } from '@canopy/shared'

import { configToolkit } from '../agents/config-agent'
import type { SendOptions } from '../agents/types'
import { checkConfig, type ConfigCheckDeps } from '../env/config-check'
import type { Services } from './context'

const TAIL_LINES = 40

/** The check, wired to the daemon's own worktree, environment and log services. */
function checkDeps({ projects, worktrees, environment, logs }: Services, projectId: string): ConfigCheckDeps {
  const project = projects.get(projectId)
  return {
    create: async (name, base) => {
      const worktree = await worktrees.create(project, { name, branch: { mode: 'new', name, base }, provision: false })
      return { id: worktree.id, path: worktree.path }
    },
    saved: () => environment.projectConfig(project).raw,
    writeConfig: (path, raw) => writeFileSync(join(path, 'canopy.yaml'), raw),
    // The checkout exists already; provisioning picks up from the files it copies.
    provision: async (id) => void (await environment.provision(id, { from: 'copy-files', autoStart: true })),
    environment: (id) => environment.environmentOf(id),
    logTail: async (id, stream) => (await logs.read(id, stream, 0, 10_000)).lines.slice(-TAIL_LINES).map((line) => line.text),
    // The checkout is throwaway: the canopy.yaml copied in is no one's work to keep in the Trash.
    destroy: async (id) => void (await worktrees.destroy(id, true, 'always', { salvage: false })),
    sleep: (ms) => sleep(ms),
    now: () => Date.now()
  }
}

/** A turn sent from the Canopy Agent carries its tools; any other turn goes out as it came. */
export function withConfigAgent<T extends TurnOptions>(services: Services, options: T): T & Pick<SendOptions, 'toolkit'> {
  const { configAgent } = options
  if (!configAgent) return options
  const deps = checkDeps(services, configAgent.projectId)
  return { ...options, toolkit: configToolkit((base) => checkConfig(deps, base)) }
}
