import type { FastifyInstance } from 'fastify'

import { CommitInput, DraftInput, ExcludeInput, GroupInput, StageHunksInput, StageInput, UnhideInput, routes } from '@canopy/shared'

import type { Services } from './context'
import { IdParams, PathQuery } from './params'

/** The commit panel: staging is the index, so every route here reads or writes it. */
export function registerCommitRoutes(app: FastifyInstance, { commits, draftText, groupBrief }: Services): void {
  app.post(routes.stage(':id'), async (request) => commits.stage(IdParams.parse(request.params).id, StageInput.parse(request.body)))

  app.get(routes.stageHunks(':id'), async (request) =>
    commits.hunkStates(IdParams.parse(request.params).id, PathQuery.parse(request.query).path)
  )

  app.post(routes.stageHunks(':id'), async (request) =>
    commits.stageHunks(IdParams.parse(request.params).id, StageHunksInput.parse(request.body))
  )

  app.post(routes.commitChanges(':id'), async (request, reply) => {
    const commit = await commits.commit(IdParams.parse(request.params).id, CommitInput.parse(request.body))
    return reply.code(201).send({ commit })
  })

  // Claude's commit message and PR drafts; it reads the same index and branch the rest of this file does.
  app.post(routes.draft(':id'), async (request) => draftText(IdParams.parse(request.params).id, DraftInput.parse(request.body)))
  // What a grouping session in the Git Agent starts from, read from the same diff the Changes pane shows.
  app.post(routes.groupBrief(':id'), async (request) => groupBrief(IdParams.parse(request.params).id, GroupInput.parse(request.body)))

  app.get(routes.hidden(':id'), async (request) => ({ hidden: await commits.hidden(IdParams.parse(request.params).id) }))

  app.post(routes.exclude(':id'), async (request) => ({
    hidden: await commits.exclude(IdParams.parse(request.params).id, ExcludeInput.parse(request.body))
  }))

  app.post(routes.unhide(':id'), async (request) => ({
    hidden: await commits.unhide(IdParams.parse(request.params).id, UnhideInput.parse(request.body))
  }))
}
