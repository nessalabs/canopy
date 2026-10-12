import type { FastifyInstance } from 'fastify'

import { CreatePullRequestInput, IssueFilter, PullRequestAction, routes } from '@canopy/shared'

import type { Services } from './context'
import { z } from 'zod'

import { IdParams } from './params'

/** `?fresh=1` waits for GitHub instead of answering from what the daemon holds. */
const FreshQuery = z.object({ fresh: z.enum(['1', 'true']).optional() })
const SearchQuery = IssueFilter.extend({ q: z.string().max(200).default('') })
const IssueParams = IdParams.extend({ number: z.coerce.number().int().positive() })
const UrlQuery = z.object({ url: z.string().url() })

/** The Git tab's Pull request pane: GitHub through the daemon host's `gh`, and the push it needs. */
export function registerGitHubRoutes(app: FastifyInstance, { github, issues, projects }: Services): void {
  const projectPath = (params: unknown): string => projects.get(IdParams.parse(params).id).path

  app.get(routes.projectIssues(':id'), async (request) => {
    const { q, ...filter } = SearchQuery.parse(request.query)
    return issues.search(projectPath(request.params), q, filter)
  })

  app.get(routes.projectIssue(':id', ':number'), async (request) => issues.read(projectPath(request.params), IssueParams.parse(request.params).number))

  app.get(routes.githubAttachment(':id'), async (request) => issues.attachment(projectPath(request.params), UrlQuery.parse(request.query).url))

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
