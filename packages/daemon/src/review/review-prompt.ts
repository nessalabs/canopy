/**
 * Turns a bundle of diff line-comments into the single user turn that gets
 * appended to the agent's own session.
 *
 * Two things make this worth formatting carefully rather than concatenating:
 *  - the agent already has the file contents and its own edit history in
 *    context, so the prompt only needs to *anchor* each note (path + line +
 *    the code it points at), not restate the diff;
 *  - `file:line` is the anchor both CLIs already resolve, so the agent can jump
 *    straight to the hunk instead of re-reading the whole file.
 */

import type { AddCommentInput, GitHubNote } from '@canopy/shared'

/** A comment as the prompt needs it: anchor + text (+ the code it points at). */
export type ReviewCommentInput = Pick<AddCommentInput, 'file' | 'line' | 'side' | 'text' | 'code'>

export interface ReviewBundle {
  comments: ReviewCommentInput[]
  /** Review threads from the PR on GitHub, each with who said it. */
  github?: GitHubNote[]
  /** Branch under review, for the header line. */
  branch?: string
  /** Optional free-text the reviewer typed alongside the comments. */
  note?: string
}

const HEADER =
  'Code review on the changes you just made. Each note below is anchored to a line in the diff.'

/** The heading for comments on the PR's conversation, which name no file. */
const CONVERSATION = 'Pull request conversation'

const FOOTER =
  'Address each note. Where you disagree, say so and explain instead of changing the code. ' +
  'Keep the changes scoped to these notes.'

export function formatReviewPrompt(bundle: ReviewBundle): string {
  const { comments, branch, note } = bundle
  const github = bundle.github ?? []
  if (comments.length === 0 && github.length === 0) throw new Error('review bundle has no comments')

  const byFile = new Map<string, ReviewCommentInput[]>()
  for (const comment of comments) {
    byFile.set(comment.file, [...(byFile.get(comment.file) ?? []), comment])
  }

  const sections: string[] = []
  for (const [file, fileComments] of byFile) {
    const lines = [...fileComments]
      .sort((a, b) => a.line - b.line)
      .map((comment) => {
        // `old` side means the note is about a line the change deleted.
        const anchor = `${file}:${comment.line}${comment.side === 'old' ? ' (removed line)' : ''}`
        const quoted = comment.code ? `\n    > ${comment.code.trim()}` : ''
        return `  - ${anchor}${quoted}\n    ${comment.text.trim()}`
      })
    sections.push(`${file}\n${lines.join('\n')}`)
  }

  if (github.length > 0) {
    const byFile = new Map<string, GitHubNote[]>()
    for (const item of github) byFile.set(item.file ?? CONVERSATION, [...(byFile.get(item.file ?? CONVERSATION) ?? []), item])
    const parts: string[] = []
    for (const [file, notes] of byFile) {
      const lines = notes.map((item) => {
        const anchor = !item.file ? 'general comment' : item.line ? `${file}:${item.line}${item.side === 'old' ? ' (removed line)' : ''}` : `${file} (line no longer in the diff)`
        const state = item.resolved ? ' [resolved on GitHub]' : ''
        const body = item.body.trim().split('\n').join('\n    ')
        return `  - ${anchor}${state} — ${item.url}\n    ${body}`
      })
      parts.push(`${file}\n${lines.join('\n')}`)
    }
    sections.push(`Review comments left on the pull request on GitHub (reviewer named on each):\n\n${parts.join('\n\n')}`)
  }

  return [
    branch ? `${HEADER} Branch: ${branch}.` : HEADER,
    '',
    sections.join('\n\n'),
    ...(note ? ['', note.trim()] : []),
    '',
    FOOTER
  ].join('\n')
}
