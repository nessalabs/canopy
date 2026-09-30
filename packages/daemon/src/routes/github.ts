import type { FastifyInstance } from 'fastify'

import { CreatePullRequestInput, routes } from '@canopy/shared'

import type { Services } from './context'
import { IdParams } from './params'

/** The Git tab's Pull request pane: GitHub through the daemon host's `gh`, and the push it needs. */
export function registerGitHubRoutes(app: FastifyInstance, { github }: Services): void {
  app.get(routes.pullRequest(':id'), async (request) => github.read(IdParams.parse(request.params).id))

  app.post(routes.pullRequest(':id'), async (request, reply) => {
    const pr = await github.create(IdParams.parse(request.params).id, CreatePullRequestInput.parse(request.body ?? {}))
    return reply.code(201).send({ pr })
  })

  app.post(routes.pullRequestFetch(':id'), async (request) => github.fetchPr(IdParams.parse(request.params).id))

  app.post(routes.push(':id'), async (request) => github.push(IdParams.parse(request.params).id))
}
