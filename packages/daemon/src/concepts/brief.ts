/**
 * The brief a concept-map session starts from. Like the grouping brief it hands the agent every
 * hunk under a short id (`hunkTable`, reused as is, so `{ path, hunk: 3 }` means the same on both
 * sides of the wire) — but it is cut from the *pull request* rather than from the working copy,
 * and it hands over the PR's own words and its commits as well, so a concept can say which commits
 * built it.
 *
 * The range is the pair of commits GitHub itself diffs (`filesRange`). A branch with no pull
 * request open falls back to two pinned snapshot trees of the branch against its base, so the pane
 * is never empty and the hunks still read once the change moves on.
 */
import { DEFAULT_CONCEPT_PROMPT, diffFingerprint } from '@canopy/shared'
import type { ConceptMapInput, ConceptMapStarted, ConceptSubject, Commit, DiffSpec, PullRequest } from '@canopy/shared'

import { hunkTable, readPatches } from '../drafts/groups'
import { badRequest } from '../lib/errors'
import type { GitHubService } from '../github/service'
import type { HistoryService } from '../worktrees/history'
import type { ConceptStore } from './store'

/** Enough commits to describe a pull request; past this the list is noise in the brief. */
const MAX_COMMITS = 50

interface Deps {
  history: Pick<HistoryService, 'snapshot' | 'trees' | 'filePatch'>
  github: Pick<GitHubService, 'read'>
  store: Pick<ConceptStore, 'add'>
}

/** The pull request's own words, which say what the author thought they were doing. */
function prWords(pr: PullRequest): string[] {
  const body = pr.body.trim()
  return [`The pull request:\n#${pr.number} ${pr.title}`, ...(body ? [body] : [])]
}

/** The commits, oldest first, so a concept can name the ones it arrived in. */
function commitLines(commits: Commit[]): string[] {
  if (commits.length === 0) return []
  const shown = commits.slice(0, MAX_COMMITS)
  const more = commits.length - shown.length
  return [
    ['Its commits, oldest first (use these shas in "commits"):', ...shown.map((commit) => `- ${commit.sha.slice(0, 10)} ${commit.subject}`), ...(more > 0 ? [`- […  ${more} more]`] : [])].join('\n')
  ]
}

export function conceptPrompt(table: string, parts: { pr?: PullRequest; commits: Commit[]; instructions?: string }): string {
  return [
    DEFAULT_CONCEPT_PROMPT,
    ...(parts.pr ? prWords(parts.pr) : []),
    ...commitLines(parts.commits),
    ...(parts.instructions ? [`How the user wants it mapped:\n${parts.instructions}`] : []),
    `The change:\n${table}`
  ].join('\n\n')
}

/** The PR to map, or null to fall back to the branch. A GitHub that cannot be reached is a fallback, not an error. */
async function pullRequestFor(github: Deps['github'], worktreeId: string, wanted: ConceptSubject | undefined): Promise<PullRequest | null> {
  if (wanted === 'branch') return null
  try {
    return (await github.read(worktreeId)).pr
  } catch {
    return null
  }
}

/**
 * A new concept map of the branch's pull request, and the brief its conversation opens with.
 */
export async function startConceptMap({ history, github, store }: Deps, worktreeId: string, input: ConceptMapInput): Promise<ConceptMapStarted> {
  const pr = await pullRequestFor(github, worktreeId, input.subject)
  const range = pr?.filesRange ?? null
  // A PR whose head or target this checkout lacks has no range to diff; the branch is the fallback.
  const spec: Extract<DiffSpec, { kind: 'trees' }> = range ? { kind: 'trees', before: range.before, after: range.after } : await history.snapshot(worktreeId, 'base')
  const { files } = await history.trees(worktreeId, spec.before, spec.after)
  if (files.length === 0) throw badRequest('nothing_to_map', 'there are no changes to map')

  const table = hunkTable(await readPatches(history, worktreeId, spec, files))
  const map = store.add(worktreeId, {
    subject: range ? 'pull-request' : 'branch',
    prNumber: range && pr ? pr.number : null,
    headSha: range && pr ? pr.headSha : null,
    instructions: input.instructions ?? '',
    before: spec.before,
    after: spec.after,
    ids: Object.fromEntries(table.refs),
    fingerprint: diffFingerprint(files)
  })
  return { map, prompt: conceptPrompt(table.text, { ...(range && pr ? { pr } : {}), commits: pr?.commitLog ?? [], ...(input.instructions ? { instructions: input.instructions } : {}) }) }
}
