/**
 * Drafting text with Claude: a commit message from what is staged, or a pull request's title and
 * body from what the branch adds over its base. Either way the answer only fills a form; nothing
 * is committed or opened until the user says so.
 *
 * A diff can be enormous (a regenerated lockfile, a vendored bundle), so its size is measured with
 * `--numstat` before it is read. Past the budget the model works from the commit messages and the
 * file list alone, which is what a pull request description is mostly built from anyway.
 */
import type { DraftInput, DraftKind, DraftSettings, ProjectSettings, TextDraft } from '@canopy/shared'

import type { GitRunner } from '../git/exec'
import { badRequest, conflict } from '../lib/errors'
import type { WorktreesService } from '../worktrees/service'

/** Past this many changed lines the diff is left out and the commits and the file list carry the draft. */
const MAX_DIFF_LINES = 3_000
/** A guard for the lines `--numstat` cannot see: minified files, long generated lines. */
const MAX_DIFF_CHARS = 120_000
/** The file list and the commit list are bounded too; the most recent commits are the ones kept. */
const MAX_STAT_FILES = 200
const MAX_COMMITS = 200

/** One prompt in, the model's text out. Production runs Claude through the Agent SDK. */
export type TextGenerator = (prompt: string, cwd: string) => Promise<string>

interface Deps {
  git: GitRunner
  worktrees: WorktreesService
  settings: (projectId: string) => ProjectSettings
  generate: TextGenerator
}

/** Labelled blocks of context appended to the instructions; `empty` means there is nothing to draft. */
interface Context {
  sections: Array<[label: string, text: string]>
  empty: boolean
}

const DIFF_FLAGS = ['diff', '--no-color', '--no-ext-diff']

/** Lines added plus removed, from `git diff --numstat`. Binary files (`-\t-`) count as none. */
export function changedLines(numstat: string): number {
  return numstat
    .split('\n')
    .map((line) => line.split('\t'))
    .reduce((sum, [added = '', removed = '']) => sum + (Number(added) || 0) + (Number(removed) || 0), 0)
}

/** The file list always; the diff itself only when it is small enough to be worth reading. */
async function diffContext(git: GitRunner, cwd: string, range: string[]): Promise<Context> {
  const numstat = await git(cwd, [...DIFF_FLAGS, '--numstat', ...range])
  const changed = changedLines(numstat)
  const [stat, diff] = await Promise.all([
    git(cwd, [...DIFF_FLAGS, `--stat-count=${MAX_STAT_FILES}`, '--stat', ...range]),
    changed <= MAX_DIFF_LINES ? git(cwd, [...DIFF_FLAGS, ...range]) : `[${changed} changed lines, too many to include; work from the file list above]`
  ])
  const clipped = diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated; see the file list above]` : diff
  return { sections: [['Files', stat], ['Diff', clipped]], empty: numstat.trim() === '' }
}

/** The remote-tracking copy of `base` when there is one — that is what GitHub compares against — else the local branch. */
async function baseRef(git: GitRunner, cwd: string, base: string): Promise<string> {
  const remote = await git(cwd, ['for-each-ref', '--count=1', '--format=%(refname:short)', `refs/remotes/*/${base}`])
  return remote.trim() || base
}

interface Source {
  prompt: keyof DraftSettings
  empty: string
  context: (git: GitRunner, cwd: string, input: DraftInput) => Promise<Context>
}

const SOURCES: Record<DraftKind, Source> = {
  commit: {
    prompt: 'commitPrompt',
    empty: 'nothing is staged; check at least one file',
    context: (git, cwd) => diffContext(git, cwd, ['--cached'])
  },
  commitAll: {
    prompt: 'commitPrompt',
    empty: 'there are no uncommitted changes',
    context: async (git, cwd) => {
      // New files are not in `git diff HEAD`; their names are enough to say they were added.
      const [diff, untracked] = await Promise.all([diffContext(git, cwd, ['HEAD']), git(cwd, ['ls-files', '--others', '--exclude-standard'])])
      const added: Context['sections'] = untracked.trim() ? [['New files', untracked]] : []
      return { sections: [...added, ...diff.sections], empty: diff.empty && added.length === 0 }
    }
  },
  pullRequest: {
    prompt: 'pullRequestPrompt',
    empty: 'this branch has no changes over its base',
    context: async (git, cwd, input) => {
      const from = await baseRef(git, cwd, input.kind === 'pullRequest' ? input.base : '')
      const [log, diff] = await Promise.all([
        git(cwd, ['log', `--max-count=${MAX_COMMITS}`, '--format=- %s%n%w(0,2,2)%b', `${from}..HEAD`]),
        diffContext(git, cwd, [`${from}...HEAD`])
      ])
      // Commits first: their messages are the main source for a PR description.
      return { sections: [['Into', from], ['Commits (newest first)', log], ...diff.sections], empty: diff.empty }
    }
  }
}

export function draftPrompt(instructions: string, branch: string, sections: Context['sections']): string {
  const blocks: Context['sections'] = [['Branch', branch || '(detached HEAD)'], ...sections]
  return [instructions.trim(), ...blocks.map(([label, text]) => `${label}:\n${text.trimEnd()}`)].join('\n\n')
}

/** A reply wrapped whole in one code fence; a fence that only closes the body's last block is left alone. */
const WRAPPING_FENCE = /^```\w*\n([\s\S]*)\n```$/

/** First non-blank line is the title, the rest the body. A fence around the whole reply is dropped. */
export function parseDraft(text: string): TextDraft {
  const trimmed = text.trim()
  const lines = (WRAPPING_FENCE.exec(trimmed)?.[1] ?? trimmed)
    .trim()
    .split('\n')
  return { title: (lines[0] ?? '').trim(), body: lines.slice(1).join('\n').trim() }
}

export async function draftText({ git, worktrees, settings, generate }: Deps, worktreeId: string, input: DraftInput): Promise<TextDraft> {
  const { path, projectId } = worktrees.location(worktreeId)
  const source = SOURCES[input.kind]
  const [context, branch] = await Promise.all([source.context(git, path, input), git(path, ['symbolic-ref', '-q', '--short', 'HEAD'], { okCodes: [0, 1] })])
  if (context.empty) throw badRequest('nothing_to_draft', source.empty)

  const prompt = draftPrompt(settings(projectId).drafts[source.prompt], branch.trim(), context.sections)
  const draft = parseDraft(await generate(prompt, path))
  if (draft.title === '') throw conflict('draft_failed', 'Claude returned an empty draft')
  return draft
}

/**
 * One tool-less, single-turn query with no saved session: the diff is already in the prompt, so
 * there is nothing for Claude to go and read, and the draft should not show up as a session.
 */
export const claudeText: TextGenerator = async (prompt, cwd) => {
  const sdk = await import('@anthropic-ai/claude-agent-sdk').catch(() => undefined)
  if (!sdk) throw conflict('claude_unavailable', 'the Claude Agent SDK is not installed')
  for await (const message of sdk.query({ prompt, options: { cwd, tools: [], maxTurns: 1, persistSession: false } })) {
    if (message.type !== 'result') continue
    if (message.subtype !== 'success' || message.is_error) throw conflict('draft_failed', `Claude could not write a draft (${message.subtype})`)
    return message.result
  }
  throw conflict('draft_failed', 'Claude ended without an answer')
}
