import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { AdoptWorktreeInput, AppSettingsPatch, ConfigWriteInput, DbResetInput, DestroyAllInput, OpenInput, ProjectSettingsPatch, ProvisionInput, ServiceAction, routes } from '@canopy/shared'

import { writeSse } from '../env/events/sse'
import { WATCH_SUPPORTED } from '../worktrees/watch'
import type { Services } from './context'
import { IdParams } from './params'

const SinceQuery = z.object({ since: z.coerce.number().int().nonnegative().optional() })
const LogsQuery = z.object({ since: z.coerce.number().int().nonnegative().optional(), limit: z.coerce.number().int().min(1).max(5000).default(400), follow: z.enum(['1', 'true']).optional() })
const ServiceParams = z.object({ id: z.string(), name: z.string(), action: ServiceAction })
const NamedParams = z.object({ id: z.string(), name: z.string() })

export function registerEnvironmentRoutes(app: FastifyInstance, { environment, projects, worktrees, logs, events }: Services): void {
  app.get(routes.host(), async () => environment.hostInfo())

  // ---- events (SSE) ----
  app.get(routes.events(), async (request, reply) => {
    const { since } = SinceQuery.parse(request.query)
    environment.wake()
    await writeSse(request, reply, (send, signal) => {
      const replay = since === undefined ? [] : events.replay(since)
      if (replay === null) send({ type: 'reset', seq: events.seq })
      else for (const event of replay) send(event)
      send({ type: 'hello', seq: events.seq, watch: WATCH_SUPPORTED })
      const off = environment.subscribe((event) => send(event))
      return new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          off()
          resolve()
        })
      })
    })
  })

  // ---- app settings ----
  app.get(routes.appSettings(), async () => ({ settings: environment.appSettings() }))
  app.patch(routes.appSettings(), async (request) => ({ settings: environment.updateAppSettings(AppSettingsPatch.parse(request.body)) }))

  // ---- project settings / config ----
  app.get(routes.projectSettings(':id'), async (request) => ({ settings: environment.settings(IdParams.parse(request.params).id) }))
  app.patch(routes.projectSettings(':id'), async (request) => {
    const { id } = IdParams.parse(request.params)
    const settings = environment.updateSettings(id, ProjectSettingsPatch.parse(request.body))
    return { settings, project: projects.get(id) }
  })

  app.get(routes.projectConfig(':id'), async (request) => environment.projectConfig(projects.get(IdParams.parse(request.params).id)))
  app.put(routes.projectConfig(':id'), async (request) => {
    const project = projects.get(IdParams.parse(request.params).id)
    const result = environment.writeProjectConfig(project, ConfigWriteInput.parse(request.body).raw)
    return { ...result, project: projects.get(project.id) }
  })
  app.post(routes.projectConfigScaffold(':id'), async (request) => environment.scaffoldConfig(projects.get(IdParams.parse(request.params).id)))
  app.get(routes.projectEnvironment(':id'), async (request) => environment.preview(projects.get(IdParams.parse(request.params).id)))
  app.get(routes.projectWtToml(':id'), async (request) => environment.wtToml(projects.get(IdParams.parse(request.params).id)))
  app.post(routes.projectWtToml(':id'), async (request) => environment.syncWtToml(projects.get(IdParams.parse(request.params).id)))

  app.post(routes.projectDbRefresh(':id', ':name'), async (request, reply) => {
    const { id, name } = NamedParams.parse(request.params)
    await environment.refreshTemplate(projects.get(id), name)
    return reply.code(204).send()
  })
  app.post(routes.projectStopAll(':id'), async (request, reply) => {
    await environment.stopAll(IdParams.parse(request.params).id)
    return reply.code(204).send()
  })
  app.post(routes.projectDestroyAll(':id'), async (request, reply) => {
    const project = projects.get(IdParams.parse(request.params).id)
    const input = DestroyAllInput.parse(request.body ?? {})
    const list = await worktrees.listForProject(project)
    for (const wt of list) {
      if (wt.isMain) continue
      await worktrees.destroy(wt.id, input.force ?? false, input.deleteBranch === undefined ? undefined : input.deleteBranch ? 'always' : 'never')
    }
    return reply.code(204).send()
  })

  // ---- worktree lifecycle ----
  app.post(routes.adoptWorktree(), async (request, reply) => {
    const input = AdoptWorktreeInput.parse(request.body)
    const row = await environment.adopt(input.path, input.autoStart)
    return reply.code(201).send({ worktree: await worktrees.get(row.id) })
  })

  const envOf = (id: string) => ({ environment: environment.environmentOf(id) })
  app.get(routes.worktreeEnvironment(':id'), async (request) => envOf(IdParams.parse(request.params).id))
  app.post(routes.worktreeStart(':id'), async (request) => {
    const { id } = IdParams.parse(request.params)
    await environment.start(id)
    return envOf(id)
  })
  app.post(routes.worktreeStop(':id'), async (request) => {
    const { id } = IdParams.parse(request.params)
    await environment.stop(id)
    return envOf(id)
  })
  app.post(routes.worktreeRestart(':id'), async (request) => {
    const { id } = IdParams.parse(request.params)
    await environment.restart(id)
    return envOf(id)
  })
  app.post(routes.worktreeProvision(':id'), async (request) => {
    const { id } = IdParams.parse(request.params)
    await environment.provision(id, ProvisionInput.parse(request.body ?? {}))
    return envOf(id)
  })
  app.post(routes.worktreeTeardown(':id'), async (request) => {
    const { id } = IdParams.parse(request.params)
    await environment.teardown(id)
    environment.reset(id)
    return envOf(id)
  })
  app.post(routes.worktreeEnvFile(':id'), async (request) => {
    const { id } = IdParams.parse(request.params)
    await environment.regenerateEnvFile(id)
    return envOf(id)
  })
  app.post(routes.worktreeOpen(':id'), async (request) => {
    const { id } = IdParams.parse(request.params)
    return environment.open(await worktrees.get(id), OpenInput.parse(request.body))
  })
  app.get(routes.worktreeResources(':id'), async (request) => {
    const { id } = IdParams.parse(request.params)
    return { samples: environment.resources(id), host: environment.hostSamples() }
  })

  app.post(routes.serviceAction(':id', ':name', ':action'), async (request) => {
    const { id, name, action } = ServiceParams.parse(request.params)
    await environment.serviceAction(id, name, action)
    return envOf(id)
  })

  app.get(routes.serviceLogs(':id', ':name'), async (request, reply) => {
    const { id, name } = NamedParams.parse(request.params)
    const { since, limit, follow } = LogsQuery.parse(request.query)
    worktrees.row(id)
    if (!follow) return logs.read(id, name, since ?? 0, limit)
    await writeSse(request, reply, async (send, signal) => {
      // Backfill what the client missed since its last offset, then go live.
      let cursor = since
      if (cursor !== undefined) {
        const backfill = await logs.read(id, name, cursor, 5000)
        if (backfill.truncated) send({ type: 'reset', nextOffset: backfill.lines[0]?.offset ?? backfill.nextOffset })
        for (const line of backfill.lines) send({ type: 'line', line })
        cursor = backfill.nextOffset
      }
      const off = logs.subscribe(id, name, (line) => {
        if (cursor !== undefined && line.offset < cursor) return
        send({ type: 'line', line })
      })
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
      off()
    })
  })

  app.post(routes.databaseReset(':id', ':name'), async (request) => {
    const { id, name } = NamedParams.parse(request.params)
    await environment.resetDatabase(id, name, DbResetInput.parse(request.body ?? {}).from)
    return envOf(id)
  })
}
