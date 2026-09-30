import type { FastifyInstance } from 'fastify'

import { CreatePullRequestInput, PullRequestAction, routes } from '@canopy/shared'

import type { Services } from './context'
import { z } from 'zod'

import { IdParams } from './params'

/** `?fresh=1` waits for GitHub instead of answering from what the daemon holds. */
const FreshQuery = z.object({ fresh: z.enum(['1', 'true']).optional() })

/** The Git tab's Pull request pane: GitHub through the daemon host's `gh`, and the push it needs. */
export function registerGitHubRoutes(app: FastifyInstance, { github, projects }: Services): void {
  app.get(routes.projectPullRequests(':id'), async (request) => github.list(projects.get(IdParams.parse(request.params).id).path))

  app.get(routes.pullRequest(':id'), async (request) => github.read(IdParams.parse(request.params).id, { fresh: FreshQuery.parse(request.query).fresh !== undefined }))

  app.post(routes.pullRequest(':id'), async (request, reply) => {
    const pr = await github.create(IdParams.parse(request.params).id, CreatePullRequestInput.parse(request.body ?? {}))
    return reply.code(201).send({ pr })
  })

  app.post(routes.pullRequestAction(':id'), async (request) => github.act(IdParams.parse(request.params).id, PullRequestAction.parse(request.body ?? {})))

  app.get(routes.pullRequestOptions(':id'), async (request) => github.options(IdParams.parse(request.params).id))

  app.get(routes.pullRequestThreads(':id'), async (request) => github.threads(IdParams.parse(request.params).id))

  app.post(routes.pullRequestFetch(':id'), async (request) => github.fetchPr(IdParams.parse(request.params).id))

  app.post(routes.push(':id'), async (request) => github.push(IdParams.parse(request.params).id))
}
