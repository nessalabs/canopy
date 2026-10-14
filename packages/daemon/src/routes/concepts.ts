import type { FastifyInstance } from 'fastify'

import { ConceptMapInput, ConceptMapPatch, routes } from '@canopy/shared'

import type { Services } from './context'
import { ConceptMapParams, IdParams } from './params'

/** The Concept Graph pane: the maps a worktree holds of its pull request. */
export function registerConceptRoutes(app: FastifyInstance, { concepts, startConceptMap }: Services): void {
  app.get(routes.conceptMaps(':id'), async (request) => ({ maps: concepts.list(IdParams.parse(request.params).id) }))

  app.post(routes.conceptMaps(':id'), async (request, reply) => reply.code(201).send(await startConceptMap(IdParams.parse(request.params).id, ConceptMapInput.parse(request.body ?? {}))))

  app.patch(routes.conceptMap(':id', ':cid'), async (request) => {
    const { id, cid } = ConceptMapParams.parse(request.params)
    return { map: concepts.update(id, cid, ConceptMapPatch.parse(request.body)) }
  })

  app.delete(routes.conceptMap(':id', ':cid'), async (request, reply) => {
    const { id, cid } = ConceptMapParams.parse(request.params)
    concepts.remove(id, cid)
    return reply.code(204).send()
  })
}
