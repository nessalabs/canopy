import type { IssueThread } from '@canopy/shared'

const KIND = { issue: 'issue', pr: 'pull request' } as const

/**
 * An issue or PR as the agent reads it when it is mentioned with `#`: what it is and where, the
 * opening post, and every comment in order. Events are left out; what people wrote is the context.
 */
export function issueContext(thread: IssueThread): string {
  const head = `GitHub ${KIND[thread.kind]} #${thread.number} in ${thread.repo} (${thread.state.toLowerCase()}): ${thread.title}\n${thread.url}`
  const posts = [
    `@${thread.author ?? 'ghost'} opened it on ${thread.createdAt.slice(0, 10)}:\n${thread.body.trim() || '(no description)'}`,
    ...thread.timeline.flatMap((item) => (item.type === 'comment' ? [`@${item.author ?? 'ghost'} commented on ${item.createdAt.slice(0, 10)}:\n${item.body.trim()}`] : []))
  ]
  return [head, ...posts].join('\n\n---\n\n')
}

/** The chip's name for a mentioned issue. */
export const issueLabel = (thread: Pick<IssueThread, 'number' | 'title'>): string => `#${thread.number} ${thread.title}`
