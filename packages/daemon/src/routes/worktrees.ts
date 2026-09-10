import type { FastifyInstance } from 'fastify'

import { routes } from '@canopy/shared'

import type { Services } from './context'
import { AgainstQuery, CommitParams, DestroyQuery, DirQuery, IdParams, PageQuery, PathQuery, RevQuery, TreesParams } from './params'

export function registerWorktreeRoutes(app: FastifyInstance, { worktrees, history }: Services): void {
  app.get(routes.worktrees(), async () => ({ worktrees: await worktrees.listAll() }))

  app.get(routes.worktree(':id'), async (request) => ({ worktree: await worktrees.get(IdParams.parse(request.params).id) }))

  app.delete(routes.worktree(':id'), async (request, reply) => {
    const { force, deleteBranch } = DestroyQuery.parse(request.query)
    await worktrees.destroy(IdParams.parse(request.params).id, force === 'true', deleteBranch === undefined ? undefined : deleteBranch === 'true' ? 'always' : 'never')
    return reply.code(204).send()
  })

  app.get(routes.changes(':id'), async (request) => {
    const { against } = AgainstQuery.parse(request.query)
    return history.changes(IdParams.parse(request.params).id, { kind: 'worktree', against })
  })

  app.get(routes.changesFile(':id'), async (request) => {
    const { against, path } = AgainstQuery.merge(PathQuery).parse(request.query)
    return history.filePatch(IdParams.parse(request.params).id, { kind: 'worktree', against }, path)
  })

  app.get(routes.tree(':id'), async (request) => history.tree(IdParams.parse(request.params).id, DirQuery.parse(request.query).path))

  app.get(routes.file(':id'), async (request) => {
    const { path, rev } = PathQuery.merge(RevQuery).parse(request.query)
    return history.file(IdParams.parse(request.params).id, path, rev)
  })

  app.get(routes.log(':id'), async (request) => {
    const { limit, skip } = PageQuery.parse(request.query)
    return history.log(IdParams.parse(request.params).id, limit, skip)
  })

  app.get(routes.commit(':id', ':sha'), async (request) => {
    const { id, sha } = CommitParams.parse(request.params)
    return history.commit(id, sha)
  })

  app.get(routes.trees(':id', ':before', ':after'), async (request) => {
    const { id, before, after } = TreesParams.parse(request.params)
    return history.trees(id, before, after)
  })

  app.get(routes.treesFile(':id', ':before', ':after'), async (request) => {
    const { id, before, after } = TreesParams.parse(request.params)
    return history.filePatch(id, { kind: 'trees', before, after }, PathQuery.parse(request.query).path)
  })

  app.get(routes.commitFile(':id', ':sha'), async (request) => {
    const { id, sha } = CommitParams.parse(request.params)
    return history.filePatch(id, { kind: 'commit', sha }, PathQuery.parse(request.query).path)
  })
}
