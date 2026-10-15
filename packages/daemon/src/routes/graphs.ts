import type { FastifyInstance } from 'fastify'

import { GraphInput, GraphPatch, routes } from '@canopy/shared'

import type { Services } from './context'
import { GraphParams, IdParams } from './params'

/** A worktree's graphs of its change: list them, start one, learn its answer, drop it. */
export function registerGraphRoutes(app: FastifyInstance, { graphs, startGraph }: Services): void {
  app.get(routes.graphs(':id'), async (request) => ({ graphs: graphs.list(IdParams.parse(request.params).id) }))

  app.post(routes.graphs(':id'), async (request, reply) => reply.code(201).send(await startGraph(IdParams.parse(request.params).id, GraphInput.parse(request.body))))

  app.patch(routes.graph(':id', ':gid'), async (request) => {
    const { id, gid } = GraphParams.parse(request.params)
    return { graph: graphs.update(id, gid, GraphPatch.parse(request.body)) }
  })

  app.delete(routes.graph(':id', ':gid'), async (request, reply) => {
    const { id, gid } = GraphParams.parse(request.params)
    graphs.remove(id, gid)
    return reply.code(204).send()
  })
}
