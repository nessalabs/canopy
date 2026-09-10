import cors from '@fastify/cors'
import type { Database } from 'better-sqlite3'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'

import { ApiError, routes } from '@canopy/shared'

import { EditDiffsService } from './agents/edit-diffs/service'
import { createSnapshots } from './agents/edit-diffs/snapshots'
import { createAgentRegistry, type AgentRegistry } from './agents/registry'
import { registerAuth } from './auth'
import type { DaemonConfig } from './config'
import { createDbRegistry } from './env/databases/registry'
import { createDocker } from './env/docker'
import { createEventBus } from './env/events/bus'
import { createLogStore } from './env/logs/store'
import { PortAllocator } from './env/ports/allocator'
import { ResourceSampler } from './env/resources/sampler'
import { EnvironmentService } from './env/service'
import { createComposeRunner } from './env/services/runners/compose'
import { createDockerRunner } from './env/services/runners/docker'
import { createHostRunner } from './env/services/runners/host'
import { loadAppSettings } from './env/settings/app-settings'
import type { DockerHelper } from './env/types'
import { createWorktrunk, type Worktrunk } from './env/worktrunk/wt'
import { createDiffReader } from './git/diff'
import { runGit, type GitRunner } from './git/exec'
import { createRepo } from './git/repo'
import { ProjectsService } from './projects/service'
import { ReviewService } from './review/service'
import { registerAgentRoutes } from './routes/agents'
import type { Services } from './routes/context'
import { registerEnvironmentRoutes } from './routes/environment'
import { registerFsRoutes } from './routes/fs'
import { registerProjectRoutes } from './routes/projects'
import { registerReviewRoutes } from './routes/review'
import { registerStatic } from './routes/static'
import { registerWorktreeRoutes } from './routes/worktrees'
import { HistoryService } from './worktrees/history'
import { WorktreesService } from './worktrees/service'

export interface ServerDeps {
  config: DaemonConfig
  db: Database
  token: string
  version?: string
  agents?: AgentRegistry
  git?: GitRunner
  /** Tests inject fakes; production talks to the real docker CLI and `wt`. */
  docker?: DockerHelper
  worktrunk?: Worktrunk
  logger?: boolean
}

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/

function errorBody(error: unknown): { status: number; body: unknown } {
  if (error instanceof ApiError) return { status: error.status, body: error.toBody() }
  if (error instanceof ZodError) {
    return { status: 400, body: { error: { code: 'validation_error', message: 'invalid request', details: error.issues } } }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { status: 500, body: { error: { code: 'internal_error', message } } }
}

export function buildServices(deps: ServerDeps): Services {
  const git = deps.git ?? runGit
  const repo = createRepo(git)
  const diffs = createDiffReader(git, repo.untracked)
  const projects = new ProjectsService(deps.db, repo, deps.config.home)
  const events = createEventBus()
  const worktrunk = deps.worktrunk ?? createWorktrunk(git)
  const worktrees = new WorktreesService({ db: deps.db, repo, projects, worktreeRoot: deps.config.worktreeRoot, worktrunk, events })
  const agents = deps.agents ?? createAgentRegistry()
  const docker = deps.docker ?? createDocker()
  const logs = createLogStore(deps.config.dataRoot)
  const appSettings = loadAppSettings(deps.config.home)
  const environment = new EnvironmentService({
    db: deps.db,
    config: deps.config,
    git,
    projects,
    worktrees,
    logs,
    events,
    docker,
    worktrunk,
    ports: new PortAllocator(deps.db, [appSettings.ports.from, appSettings.ports.to]),
    databases: createDbRegistry({ docker, dataRoot: deps.config.dataRoot }),
    runners: { host: createHostRunner(), docker: createDockerRunner(docker), compose: createComposeRunner(docker) },
    sampler: new ResourceSampler(docker)
  })
  worktrees.attachEnvironment(environment)
  return {
    config: deps.config,
    version: deps.version ?? '0.1.0',
    projects,
    worktrees,
    history: new HistoryService({ repo, diffs, worktrees }),
    review: new ReviewService({ db: deps.db, worktrees, agents }),
    agents,
    editDiffs: new EditDiffsService({ db: deps.db, worktrees, snapshots: createSnapshots(git) }),
    environment,
    logs,
    events
  }
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  // SSE streams stay open for hours; close() must not wait for them.
  const app = Fastify({ logger: deps.logger ?? false, forceCloseConnections: true })
  const services = buildServices(deps)

  await app.register(cors, {
    // Electron in production loads file://, which sends `Origin: null`.
    origin: (origin, cb) => cb(null, !origin || origin === 'null' || LOCAL_ORIGIN.test(origin)),
    // The default allow-list is GET/HEAD/POST; the API also destroys (DELETE), patches settings and writes canopy.yaml (PUT).
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type']
  })
  registerAuth(app, deps.token)
  app.setErrorHandler((error, _request, reply) => {
    const { status, body } = errorBody(error)
    if (status >= 500) app.log.error(error)
    return reply.code(status).send(body)
  })

  app.get(routes.healthz(), async () => ({ ok: true, version: services.version }))
  registerProjectRoutes(app, services)
  registerWorktreeRoutes(app, services)
  registerReviewRoutes(app, services)
  registerAgentRoutes(app, services)
  registerEnvironmentRoutes(app, services)
  registerFsRoutes(app)
  await registerStatic(app, deps.config.webDist)

  app.addHook('onClose', async () => {
    await services.environment.shutdown()
  })
  app.decorate('services', services)

  return app
}

declare module 'fastify' {
  interface FastifyInstance {
    services: Services
  }
}
