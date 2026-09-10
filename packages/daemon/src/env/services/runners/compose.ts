/**
 * Compose runner: a whole `docker compose` stack supervised as if it were one process.
 *
 * `up` runs in the FOREGROUND on purpose. Detached compose would leave the supervisor polling for
 * state it cannot see; keeping the process attached means compose's own output is the service log
 * and compose's exit is the service's exit, so restart policy, health checks and the Logs panel
 * work exactly as they do for a host process. Isolation comes from the project name
 * (`canopy-<id8>-<service>`), which namespaces the stack's containers, networks and volumes, and
 * from an `--env-file` we generate from the worktree's resolved env so `${VAR}` in the compose file
 * picks up this worktree's ports instead of the developer's shell.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { DockerHelper, ResolvedService, RunContext, RunningHandle, ServiceRunner } from '../../types'
import { shortId } from './docker'

/** Compose project names must be lowercase alphanumeric plus `_-`. */
export const composeProjectName = (worktreeId: string, service: string): string => `canopy-${shortId(worktreeId)}-${service}`.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')

export interface ComposeInvocation {
  project: string
  /** Absolute path to the compose file. */
  file: string
  profiles?: string[]
  envFile?: string | null
}

/** `docker compose …` argv shared by up/stop/ps/down, so every call targets the same project. */
export function composeArgs(invocation: ComposeInvocation, ...rest: string[]): string[] {
  const args = ['compose', '-p', invocation.project, '-f', invocation.file]
  for (const profile of invocation.profiles ?? []) args.push('--profile', profile)
  if (invocation.envFile) args.push('--env-file', invocation.envFile)
  return [...args, ...rest]
}

/**
 * `up` in the foreground. `--abort-on-container-exit=false` is explicit: one container of the stack
 * exiting (a migration sidecar, say) must not tear the rest down behind the supervisor's back.
 */
export const composeUpArgs = (invocation: ComposeInvocation, services: string[] = []): string[] =>
  composeArgs(invocation, 'up', '--no-color', '--abort-on-container-exit=false', ...services)

/** dotenv text for compose's `--env-file`; compose has no escaping, so newlines are flattened. */
export function envFileText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value.replace(/\r?\n/g, ' ')}`)
    .join('\n')
    .concat('\n')
}

export function createComposeRunner(docker: DockerHelper): ServiceRunner {
  /** The live `up` stream per project, so `stop` can detach without killing the containers. */
  const streams = new Map<string, AbortController>()

  const invocationFor = (ctx: RunContext, service: ResolvedService): ComposeInvocation => ({
    project: composeProjectName(ctx.worktreeId, service.name),
    file: resolve(ctx.worktreePath, service.spec.compose?.file ?? 'docker-compose.yml'),
    profiles: service.spec.compose?.profiles ?? [],
    envFile: join(ctx.dataDir, `compose-${service.name}.env`)
  })

  return {
    kind: 'compose',

    async start(ctx: RunContext, service: ResolvedService): Promise<RunningHandle> {
      const invocation = invocationFor(ctx, service)
      await mkdir(ctx.dataDir, { recursive: true })
      if (invocation.envFile) await writeFile(invocation.envFile, envFileText(service.env), 'utf8')

      const controller = new AbortController()
      streams.set(invocation.project, controller)
      const args = composeUpArgs(invocation, service.spec.compose?.services ?? [])
      ctx.logs.sys(`compose up (project ${invocation.project})`)

      const exited = docker
        .stream(args, (stream, text) => (stream === 'out' ? ctx.logs.out(text) : ctx.logs.err(text)), { cwd: ctx.worktreePath, signal: controller.signal })
        .then((result) => {
          streams.delete(invocation.project)
          return { code: result.exitCode, signal: null }
        })
        .catch(() => {
          streams.delete(invocation.project)
          return { code: null, signal: null }
        })

      return { kind: 'compose', composeProject: invocation.project, exited }
    },

    async stop(handle: RunningHandle, service: ResolvedService, ctx: RunContext): Promise<void> {
      const project = handle.composeProject
      if (!project) return
      const invocation = { ...invocationFor(ctx, service), project }
      const stopTimeoutSec = Math.max(1, Math.round(service.stopTimeoutMs / 1000))
      ctx.logs.sys(`compose stop (project ${project})`)
      try {
        // `stop`, not `down`: the containers stay so the next start is a resume, not a rebuild.
        await docker.run(composeArgs(invocation, 'stop', '-t', String(stopTimeoutSec)), { okCodes: [0, 1], cwd: ctx.worktreePath })
      } catch (error) {
        ctx.logs.sys(`compose stop: ${error instanceof Error ? error.message : String(error)}`)
      }
      streams.get(project)?.abort()
      streams.delete(project)
    },

    async alive(handle: RunningHandle): Promise<boolean> {
      const project = handle.composeProject
      if (!project) return false
      try {
        const result = await docker.run(['compose', '-p', project, 'ps', '-q', '--status', 'running'], { okCodes: [0, 1] })
        return result.stdout.trim().length > 0
      } catch {
        return false
      }
    },

    async reap(ctx: RunContext, service: ResolvedService, previous: Pick<RunningHandle, 'pid' | 'pidStart' | 'containerId' | 'composeProject'>): Promise<void> {
      const project = previous.composeProject ?? composeProjectName(ctx.worktreeId, service.name)
      try {
        streams.get(project)?.abort()
        streams.delete(project)
        const invocation = { ...invocationFor(ctx, service), project }
        // Destroy path: volumes and orphans go too, otherwise a rebuilt worktree inherits old data.
        await docker.run(composeArgs(invocation, 'down', '-v', '--remove-orphans'), { okCodes: [0, 1], cwd: ctx.worktreePath })
      } catch {
        // Best effort: a missing compose file or a stopped docker daemon must not fail teardown.
      }
    }
  }
}
