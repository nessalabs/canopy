import type { FastifyInstance } from 'fastify'

import { AddCommentInput, ReviewRequest, routes } from '@canopy/shared'

import { streamSse } from '../lib/sse'
import type { Services } from './context'
import { CommentParams, IdParams } from './params'

export function registerReviewRoutes(app: FastifyInstance, { review }: Services): void {
  app.get(routes.comments(':id'), async (request) => ({ comments: review.list(IdParams.parse(request.params).id) }))

  app.post(routes.comments(':id'), async (request, reply) => {
    const comment = review.add(IdParams.parse(request.params).id, AddCommentInput.parse(request.body))
    return reply.code(201).send({ comment })
  })

  app.delete(routes.comment(':id', ':cid'), async (request, reply) => {
    const { id, cid } = CommentParams.parse(request.params)
    review.remove(id, cid)
    return reply.code(204).send()
  })

  app.post(routes.review(':id'), async (request, reply) => {
    const { id } = IdParams.parse(request.params)
    const turn = review.prepare(id, ReviewRequest.parse(request.body))
    await streamSse(request, reply, (signal) => review.stream(turn, signal))
  })
}
