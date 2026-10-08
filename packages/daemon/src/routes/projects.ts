import type { FastifyInstance } from 'fastify'

import { AddProjectInput, CreateWorktreeInput, ScanProjectInput, UpdateProjectInput, routes } from '@canopy/shared'

import type { Services } from './context'
import { IdParams, TrashParams } from './params'

export function registerProjectRoutes(app: FastifyInstance, { projects, worktrees, trash, environment }: Services): void {
  app.get(routes.projects(), async () => ({ projects: projects.list() }))

  app.post(routes.scanProject(), async (request) => projects.scan(ScanProjectInput.parse(request.body).path))

  app.post(routes.projects(), async (request, reply) => {
    const project = await projects.add(AddProjectInput.parse(request.body))
    return reply.code(201).send({ project })
  })

  app.get(routes.project(':id'), async (request) => {
    const project = projects.get(IdParams.parse(request.params).id)
    return { project, worktrees: await worktrees.listForProject(project) }
  })

  app.patch(routes.project(':id'), async (request) => ({
    project: projects.update(IdParams.parse(request.params).id, UpdateProjectInput.parse(request.body))
  }))

  app.delete(routes.project(':id'), async (request, reply) => {
    projects.remove(IdParams.parse(request.params).id)
    return reply.code(204).send()
  })

  app.get(routes.branches(':id'), async (request) => projects.branches(IdParams.parse(request.params).id))

  app.get(routes.remoteBranches(':id'), async (request) => projects.remoteBranches(IdParams.parse(request.params).id))

  app.post(routes.projectWorktrees(':id'), async (request, reply) => {
    const project = projects.get(IdParams.parse(request.params).id)
    const worktree = await worktrees.create(project, CreateWorktreeInput.parse(request.body))
    return reply.code(201).send({ worktree })
  })

  // ---- trash: worktrees destroyed with uncommitted work in them ----

  app.get(routes.projectTrash(':id'), async (request) => ({ entries: await trash.list(projects.get(IdParams.parse(request.params).id)) }))

  app.post(routes.trashRestore(':id', ':entry'), async (request) => {
    const { id, entry } = TrashParams.parse(request.params)
    const project = projects.get(id)
    const plan = await trash.restore(project, entry)
    // The checkout exists again; adoption is what makes it a worktree Canopy runs.
    const row = await environment.adopt(plan.path)
    return { worktree: await worktrees.get(row.id), restored: plan.files.length }
  })

  app.delete(routes.trashEntry(':id', ':entry'), async (request, reply) => {
    const { id, entry } = TrashParams.parse(request.params)
    await trash.purge(projects.get(id), entry)
    return reply.code(204).send()
  })
}
