/**
 * The brief a graph conversation starts from. Whatever the scope — the uncommitted change, the
 * branch, a run of commits, the pull request — it comes down to two pinned trees, so the hunks the
 * answer names can still be shown once the change is committed, pushed or rebased. Every hunk
 * between them goes to the agent under a short id, with the preset's words on what to draw and,
 * where there are some, the commits and the PR's own description.
 */
import { GraphInput, diffFingerprint, graphPrompt } from '@canopy/shared'
import type { Commit, DiffSpec, GraphScope, GraphStarted, PullRequest } from '@canopy/shared'

import type { GitHubService } from '../github/service'
import { badRequest } from '../lib/errors'
import type { HistoryService } from '../worktrees/history'
import { hunkTable, readPatches } from './hunks'
import type { GraphStore } from './store'

/** Enough commits to describe a change; past this the list is noise in the brief. */
const MAX_COMMITS = 50

export interface GraphDeps {
  history: Pick<HistoryService, 'snapshot' | 'pinned' | 'commitRange' | 'trees' | 'filePatch'>
  github: Pick<GitHubService, 'read' | 'pullRequest'>
  store: Pick<GraphStore, 'add'>
}

interface Cut {
  spec: Extract<DiffSpec, { kind: 'trees' }>
  commits: Commit[]
  pr?: PullRequest
}

/** The pull request's own words, which say what the author thought they were doing. */
function prWords(pr: PullRequest): string {
  const body = pr.body.trim()
  return [`The pull request:\n#${pr.number} ${pr.title}`, ...(body ? [body] : [])].join('\n\n')
}

/** The commits, oldest first, so a node can name the ones it arrived in. */
function commitLines(commits: Commit[]): string[] {
  if (commits.length === 0) return []
  const shown = commits.slice(0, MAX_COMMITS)
  const more = commits.length - shown.length
  return [['Its commits, oldest first (use these shas in "commits"):', ...shown.map((c) => `- ${c.sha.slice(0, 10)} ${c.subject}`), ...(more > 0 ? [`- […  ${more} more]`] : [])].join('\n')]
}

/** The scope as two pinned trees, and what it carries besides. */
async function cut({ history, github }: GraphDeps, worktreeId: string, scope: GraphScope): Promise<Cut> {
  switch (scope.kind) {
    case 'uncommitted':
      return { spec: await history.snapshot(worktreeId, 'head'), commits: [] }
    case 'branch':
      return { spec: await history.snapshot(worktreeId, 'base'), commits: [] }
    case 'commits':
      return history.commitRange(worktreeId, scope.from, scope.to)
    case 'pull-request': {
      // Read fresh: a graph pins the PR's head and range, and a cached answer may predate a push.
      const pr = scope.number !== undefined ? await github.pullRequest(worktreeId, scope.number) : (await github.read(worktreeId, { fresh: true })).pr
      if (!pr) throw badRequest('no_pull_request', 'this branch has no pull request')
      if (!pr.filesRange) throw badRequest('pull_request_not_local', 'this checkout lacks the pull request’s head or target; fetch first')
      // GitHub's two commits are pinned to their trees, so the graph reads after a force-push.
      const [before, after] = await Promise.all([history.pinned(worktreeId, pr.filesRange.before), history.pinned(worktreeId, pr.filesRange.after)])
      return { spec: { kind: 'trees', before, after }, commits: pr.commitLog, pr }
    }
  }
}

/** A new graph of the change the scope names, and the brief its conversation opens with. */
export async function startGraph(deps: GraphDeps, worktreeId: string, raw: GraphInput): Promise<GraphStarted> {
  const input = GraphInput.parse(raw)
  const { spec, commits, pr } = await cut(deps, worktreeId, input.scope)
  const { files } = await deps.history.trees(worktreeId, spec.before, spec.after)
  if (files.length === 0) throw badRequest('nothing_to_graph', 'there are no changes to draw')

  const table = hunkTable(await readPatches(deps.history, worktreeId, spec, files))
  const graph = deps.store.add(worktreeId, {
    scope: input.scope,
    preset: input.preset,
    instructions: input.instructions ?? '',
    before: spec.before,
    after: spec.after,
    ids: Object.fromEntries(table.refs),
    lines: Object.fromEntries(table.lines),
    fingerprint: diffFingerprint(files),
    ...(pr ? { prNumber: pr.number, headSha: pr.headSha } : {})
  })
  const context = [...(pr ? [prWords(pr)] : []), ...commitLines(commits)]
  return { graph, prompt: graphPrompt(input.preset, { table: table.text, context, ...(input.instructions ? { instructions: input.instructions } : {}) }) }
}
