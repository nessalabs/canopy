import type { FastifyInstance } from 'fastify'

import { MergeInput, routes, StartDestroyJobInput } from '@canopy/shared'

import type { Services } from './context'
import { AgainstQuery, CommitParams, DestroyQuery, DirQuery, IdParams, PageQuery, PathQuery, RevQuery, TreesParams } from './params'

export function registerWorktreeRoutes(app: FastifyInstance, { worktrees, history, watch, merges, destroyJobs }: Services): void {
  // Reading the list is what arms the per-project watch on git's worktree administration:
  // from here on a worktree added or removed outside this daemon is pushed, not waited for.
  app.get(routes.worktrees(), async () => {
    watch.ensureProjects()
    return { worktrees: await worktrees.listAll() }
  })

  app.get(routes.worktree(':id'), async (request) => ({ worktree: await worktrees.get(IdParams.parse(request.params).id) }))

  // Answers with the salvage commit rather than 204: a forced destroy discards uncommitted
  // work, and the caller needs to be told where it was put.
  app.delete(routes.worktree(':id'), async (request) => {
    const { force, deleteBranch } = DestroyQuery.parse(request.query)
    return worktrees.destroy(IdParams.parse(request.params).id, force === 'true', deleteBranch === undefined ? undefined : deleteBranch === 'true' ? 'always' : 'never')
  })

  // A static path, so Fastify matches it ahead of `/worktrees/:id` whatever the order here.
  // 202: the job is queued, not done; its progress arrives as `destroy-job` events.
  app.post(routes.destroyJobs(), async (request, reply) => {
    const job = destroyJobs.start(StartDestroyJobInput.parse(request.body))
    return reply.code(202).send({ job })
  })

  app.get(routes.destroyJobs(), async () => ({ jobs: destroyJobs.list() }))

  app.post(routes.merge(':id'), async (request) => merges.merge(IdParams.parse(request.params).id, MergeInput.parse(request.body ?? {})))

  // Reading a worktree's files or changes is what starts its watcher: from then on the client
  // hears about edits instead of asking on a timer.
  app.get(routes.changes(':id'), async (request) => {
    watch.ensure(IdParams.parse(request.params).id)
    const { against } = AgainstQuery.parse(request.query)
    return history.changes(IdParams.parse(request.params).id, { kind: 'worktree', against })
  })

  app.get(routes.changesFile(':id'), async (request) => {
    const { against, path } = AgainstQuery.merge(PathQuery).parse(request.query)
    return history.filePatch(IdParams.parse(request.params).id, { kind: 'worktree', against }, path)
  })

  app.get(routes.tree(':id'), async (request) => {
    const { id } = IdParams.parse(request.params)
    watch.ensure(id)
    return history.tree(id, DirQuery.parse(request.query).path)
  })

  app.get(routes.files(':id'), async (request) => {
    const { id } = IdParams.parse(request.params)
    watch.ensure(id)
    return history.files(id)
  })

  app.get(routes.file(':id'), async (request) => {
    const { path, rev } = PathQuery.merge(RevQuery).parse(request.query)
    const { id } = IdParams.parse(request.params)
    // A blob at a commit never changes; only a working-tree read needs the watcher.
    if (rev === undefined) watch.ensure(id)
    return history.file(id, path, rev)
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
