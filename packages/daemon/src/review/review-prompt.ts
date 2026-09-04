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

import type { AddCommentInput } from '@canopy/shared'

/** A comment as the prompt needs it: anchor + text (+ the code it points at). */
export type ReviewCommentInput = Pick<AddCommentInput, 'file' | 'line' | 'side' | 'text' | 'code'>

export interface ReviewBundle {
  comments: ReviewCommentInput[]
  /** Branch under review, for the header line. */
  branch?: string
  /** Optional free-text the reviewer typed alongside the comments. */
  note?: string
}

const HEADER =
  'Code review on the changes you just made. Each note below is anchored to a line in the diff.'

const FOOTER =
  'Address each note. Where you disagree, say so and explain instead of changing the code. ' +
  'Keep the changes scoped to these notes.'

export function formatReviewPrompt(bundle: ReviewBundle): string {
  const { comments, branch, note } = bundle
  if (comments.length === 0) throw new Error('review bundle has no comments')

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

  return [
    branch ? `${HEADER} Branch: ${branch}.` : HEADER,
    '',
    sections.join('\n\n'),
    ...(note ? ['', note.trim()] : []),
    '',
    FOOTER
  ].join('\n')
}
