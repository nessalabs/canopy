/**
 * Docker runner: one container per service per worktree.
 *
 * The container is named and labelled deterministically (`canopy-<id8>-<service>`, plus
 * `canopy.worktree` / `canopy.service` labels) for one reason: after a daemon crash the only
 * record of what we started may be Docker's own state, and reconcile has to find those containers
 * again from nothing but the worktree id. Ports are published with the same number on both sides
 * so `${ports.api}` means the same thing inside the container, in the env file and in the browser.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, posix, resolve } from 'node:path'

import { ApiError } from '../../../lib/errors'
import { CANOPY_LABEL, CANOPY_NETWORK, SERVICE_LABEL, WORKTREE_LABEL, type DockerHelper, type ResolvedService, type RunContext, type RunningHandle, type ServiceRunner } from '../../types'

/** Docker object names allow `[a-zA-Z0-9][a-zA-Z0-9_.-]*`; ids and service names may not. */
const sanitize = (text: string): string => text.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^[^a-zA-Z0-9]+/, '')

/** Worktree ids are uuids: eight characters are unique enough for a name and short enough to read. */
export const shortId = (worktreeId: string): string => sanitize(worktreeId).slice(0, 8)

/** The one place container names are built; reconcile and reap both depend on it being stable. */
export const containerName = (worktreeId: string, service: string): string => `canopy-${shortId(worktreeId)}-${sanitize(service)}`

/** Image name for a service built from a Dockerfile; the tag is the Dockerfile's content hash. */
export const imageTag = (projectName: string, service: string, hash: string): string => `canopy/${sanitize(projectName).toLowerCase()}-${sanitize(service).toLowerCase()}:${hash}`

/**
 * Resolves one `docker.volumes` entry. A bare name (`cache:/app/cache`) is a named volume; anything
 * that looks like a path is resolved against the worktree so `./tmp:/tmp` means this worktree's tmp.
 */
export function resolveVolume(entry: string, worktreePath: string): string {
  const separator = entry.indexOf(':')
  if (separator <= 0) return entry
  const host = entry.slice(0, separator)
  const rest = entry.slice(separator + 1)
  const looksLikePath = host.startsWith('.') || host.startsWith('/') || host.startsWith('~') || host.includes('/')
  if (!looksLikePath) return entry
  return `${isAbsolute(host) ? host : resolve(worktreePath, host)}:${rest}`
}

export interface DockerRunPlan {
  name: string
  image: string
  worktreeId: string
  worktreePath: string
  service: ResolvedService
  network?: string
}

/**
 * The full `docker run` argv. Pure, so the arg order (which is easy to get subtly wrong) is unit
 * tested. Note that nothing forces the app to listen on 0.0.0.0: a service that binds 127.0.0.1
 * inside its container is unreachable from the host even with `-p`, and that is the app's own
 * config to fix — Canopy deliberately does not inject a HOST env var and second-guess the image.
 */
export function dockerRunArgs(plan: DockerRunPlan): string[] {
  const { service, worktreePath } = plan
  const docker = service.spec.docker
  const workdir = docker?.workdir || '/workspace'
  const args = [
    'run',
    '-d',
    '--name',
    plan.name,
    '--label',
    `${CANOPY_LABEL}=true`,
    '--label',
    `${WORKTREE_LABEL}=${plan.worktreeId}`,
    '--label',
    `${SERVICE_LABEL}=${service.name}`,
    '--network',
    plan.network ?? CANOPY_NETWORK,
    '-v',
    `${worktreePath}:${workdir}`,
    '-w',
    service.spec.cwd ? posix.join(workdir, service.spec.cwd) : workdir
  ]
  for (const [key, value] of Object.entries(service.env)) args.push('-e', `${key}=${value}`)
  for (const port of service.ports) args.push('-p', `${port.port}:${port.port}`)
  if (docker?.user) args.push('--user', docker.user)
  for (const volume of docker?.volumes ?? []) args.push('-v', resolveVolume(volume, worktreePath))
  args.push(...(docker?.args ?? []))
  args.push(plan.image, 'sh', '-c', service.command)
  return args
}

/** `docker build` argv for a service with `docker.dockerfile`. */
export function dockerBuildArgs(dockerfile: string, tag: string, context: string): string[] {
  return ['build', '-f', dockerfile, '-t', tag, context]
}

/** Reads `State.Running` out of `docker inspect`, tolerating both the array and object shapes. */
export function inspectRunning(info: Record<string, unknown> | null): boolean {
  if (!info) return false
  const record = Array.isArray(info) ? (info[0] as Record<string, unknown> | undefined) : info
  const state = record?.['State'] as { Running?: unknown; Status?: unknown } | undefined
  if (!state) return false
  return state.Running === true || state.Status === 'running'
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function createDockerRunner(docker: DockerHelper): ServiceRunner {
  /** Builds (or reuses) the image for a Dockerfile-backed service; the content hash is the tag. */
  const buildImage = async (ctx: RunContext, service: ResolvedService): Promise<string> => {
    const spec = service.spec.docker
    if (!spec?.dockerfile) throw new ApiError(500, 'service_docker_invalid', `${service.name}: no dockerfile`)
    const dockerfile = resolve(ctx.worktreePath, spec.dockerfile)
    const contents = await readFile(dockerfile, 'utf8').catch(() => {
      throw new ApiError(500, 'service_docker_invalid', `${service.name}: ${spec.dockerfile} not found`)
    })
    const hash = createHash('sha1').update(contents).digest('hex').slice(0, 12)
    const tag = imageTag(ctx.projectName, service.name, hash)
    // An identical Dockerfile keeps the same tag, so the build is a no-op cache hit after the first.
    const existing = await docker.inspect(tag).catch(() => null)
    if (existing) return tag
    ctx.logs.sys(`building ${tag} from ${spec.dockerfile}`)
    const context = resolve(ctx.worktreePath, spec.context ?? '.')
    const build = await docker.stream(dockerBuildArgs(dockerfile, tag, context), (stream, text) => (stream === 'out' ? ctx.logs.out(text) : ctx.logs.err(text)))
    if (build.exitCode !== 0) throw new ApiError(500, 'service_docker_build_failed', `${service.name}: docker build exited ${build.exitCode}`)
    return tag
  }

  return {
    kind: 'docker',

    async start(ctx: RunContext, service: ResolvedService): Promise<RunningHandle> {
      const name = containerName(ctx.worktreeId, service.name)
      await docker.ensureNetwork(CANOPY_NETWORK)
      // A container from a previous run holds the name (and the port); it is always stale by now.
      await docker.remove(name, { volumes: false })

      const spec = service.spec.docker
      let image: string
      if (spec?.dockerfile) image = await buildImage(ctx, service)
      else if (spec?.image) {
        image = spec.image
        await docker.ensureImage(image, (text) => ctx.logs.sys(text))
      } else throw new ApiError(500, 'service_docker_invalid', `${service.name}: needs docker.image or docker.dockerfile`)

      const args = dockerRunArgs({ name, image, worktreeId: ctx.worktreeId, worktreePath: ctx.worktreePath, service })
      const created = await docker.run(args)
      const id = created.stdout.trim().split('\n').pop()?.trim() || name
      ctx.logs.sys(`container ${name} (${id.slice(0, 12)}) from ${image}`)

      // `--tail 0` because the container was just created: everything from here is live output.
      const logs = new AbortController()
      void docker
        .stream(['logs', '-f', '--tail', '0', id], (stream, text) => (stream === 'out' ? ctx.logs.out(text) : ctx.logs.err(text)), { signal: logs.signal })
        .catch(() => {})

      // `docker wait` blocks until the container stops and prints its exit code — the container
      // equivalent of waitpid(), and the only way to learn the code without polling inspect.
      let code = ''
      const exited = docker
        .stream(['wait', id], (stream, text) => {
          if (stream === 'out' && text.trim()) code = text.trim()
        })
        .then(() => {
          logs.abort()
          const parsed = Number.parseInt(code, 10)
          return { code: Number.isFinite(parsed) ? parsed : null, signal: null }
        })
        .catch(() => {
          logs.abort()
          return { code: null, signal: null }
        })

      return { kind: 'docker', containerId: id, exited }
    },

    async stop(handle: RunningHandle, service: ResolvedService, ctx: RunContext): Promise<void> {
      const id = handle.containerId
      if (!id) return
      const stopTimeoutSec = Math.max(1, Math.round(service.stopTimeoutMs / 1000))
      ctx.logs.sys(`stopping container ${id.slice(0, 12)}`)
      try {
        await docker.run(['stop', '-t', String(stopTimeoutSec), id], { okCodes: [0, 1] })
      } catch (error) {
        ctx.logs.sys(`docker stop: ${message(error)}`)
      }
      await docker.remove(id, { stopTimeoutSec, volumes: false })
    },

    async alive(handle: RunningHandle): Promise<boolean> {
      if (!handle.containerId) return false
      const info = await docker.inspect(handle.containerId).catch(() => null)
      return inspectRunning(info)
    },

    async reap(ctx: RunContext, service: ResolvedService, previous: Pick<RunningHandle, 'pid' | 'pidStart' | 'containerId' | 'composeProject'>): Promise<void> {
      try {
        if (previous.containerId) await docker.remove(previous.containerId, { volumes: false })
        // The recorded id can be missing or wrong (crash before persist); the labels are the truth.
        const stale = await docker.ps({ [WORKTREE_LABEL]: ctx.worktreeId, [SERVICE_LABEL]: service.name }, { all: true })
        for (const container of stale) await docker.remove(container.id, { volumes: false })
      } catch {
        // Boot reconcile and destroy both call this; a docker hiccup may not fail either.
      }
    }
  }
}
