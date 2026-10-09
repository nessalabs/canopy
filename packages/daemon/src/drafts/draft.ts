/**
 * Drafting text with Claude: a commit message from what is staged, or a pull request's title and
 * body from what the branch adds over its base. Either way the answer only fills a form; nothing
 * is committed or opened until the user says so.
 */
import type { DraftInput, DraftKind, DraftSettings, ProjectSettings, TextDraft } from '@canopy/shared'

import type { GitRunner } from '../git/exec'
import { badRequest, conflict } from '../lib/errors'
import type { WorktreesService } from '../worktrees/service'

/** Enough for any reviewable change; past it the model gets the head of the diff and the file list. */
const MAX_DIFF_CHARS = 120_000

/** One prompt in, the model's text out. Production runs Claude through the Agent SDK. */
export type TextGenerator = (prompt: string, cwd: string) => Promise<string>

interface Deps {
  git: GitRunner
  worktrees: WorktreesService
  settings: (projectId: string) => ProjectSettings
  generate: TextGenerator
}

/** Labelled blocks of context appended to the instructions; an empty diff means there is nothing to draft. */
interface Context {
  sections: Array<[label: string, text: string]>
  diff: string
}

const DIFF_FLAGS = ['diff', '--no-color', '--no-ext-diff']

async function diffContext(git: GitRunner, cwd: string, range: string[]): Promise<Context> {
  const [stat, diff] = await Promise.all([git(cwd, [...DIFF_FLAGS, '--stat', ...range]), git(cwd, [...DIFF_FLAGS, ...range])])
  return { sections: [['Files', stat]], diff }
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
  pullRequest: {
    prompt: 'pullRequestPrompt',
    empty: 'this branch has no changes over its base',
    context: async (git, cwd, input) => {
      const from = await baseRef(git, cwd, input.kind === 'pullRequest' ? input.base : '')
      const [log, diff] = await Promise.all([git(cwd, ['log', '--reverse', '--format=- %s%n%w(0,2,2)%b', `${from}..HEAD`]), diffContext(git, cwd, [`${from}...HEAD`])])
      return { sections: [['Into', from], ['Commits', log], ...diff.sections], diff: diff.diff }
    }
  }
}

export function draftPrompt(instructions: string, branch: string, { sections, diff }: Context): string {
  const clipped = diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated; see the file list above]` : diff
  const blocks: Context['sections'] = [['Branch', branch || '(detached HEAD)'], ...sections, ['Diff', clipped]]
  return [instructions.trim(), ...blocks.map(([label, text]) => `${label}:\n${text.trimEnd()}`)].join('\n\n')
}

/** First non-blank line is the title, the rest the body. A fence around the whole reply is dropped. */
export function parseDraft(text: string): TextDraft {
  const lines = text
    .trim()
    .replace(/^```\w*\n|\n```$/g, '')
    .trim()
    .split('\n')
  return { title: (lines[0] ?? '').trim(), body: lines.slice(1).join('\n').trim() }
}

export async function draftText({ git, worktrees, settings, generate }: Deps, worktreeId: string, input: DraftInput): Promise<TextDraft> {
  const { path, projectId } = worktrees.location(worktreeId)
  const source = SOURCES[input.kind]
  const [context, branch] = await Promise.all([source.context(git, path, input), git(path, ['symbolic-ref', '-q', '--short', 'HEAD'], { okCodes: [0, 1] })])
  if (context.diff.trim() === '') throw badRequest('nothing_to_draft', source.empty)

  const prompt = draftPrompt(settings(projectId).drafts[source.prompt], branch.trim(), context)
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
