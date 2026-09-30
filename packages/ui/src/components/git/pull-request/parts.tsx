import { useState } from 'react'
import { CircleCheck, CircleDashed, CircleMinus, CircleX, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, MessageSquare } from 'lucide-react'

import type { PullRequest, PullRequestCheck, PullRequestReviewer, ReviewComment } from '@canopy/shared'

import type { DiffMode } from '@/components/worktree-diff'
import { MessageMarkdown } from '@/components/ui/message-markdown'
import { RandomAvatar } from '@/components/ui/random-avatar'
import { plural } from '@/lib/format'
import { usePlatform } from '@/providers/platform'

/** What a diff needs from the Git tab: its comments, its view mode, and review sending. */
export interface ReviewProps {
  comments: ReviewComment[]
  mode: DiffMode
  onModeChange: (mode: DiffMode) => void
  onSendForReview: () => void
  sending: boolean
}

type Look = { label: string; Icon: React.ComponentType<{ className?: string }>; className: string }

export const STATE_LOOK: Record<'OPEN' | 'DRAFT' | 'MERGED' | 'CLOSED', Look> = {
  OPEN: { label: 'Open', Icon: GitPullRequest, className: 'border-transparent bg-emerald-600 text-white' },
  DRAFT: { label: 'Draft', Icon: GitPullRequestDraft, className: 'border-transparent bg-muted text-muted-foreground' },
  MERGED: { label: 'Merged', Icon: GitMerge, className: 'border-transparent bg-violet-600 text-white' },
  CLOSED: { label: 'Closed', Icon: GitPullRequestClosed, className: 'border-transparent bg-destructive text-destructive-foreground' }
}

export const stateLook = (pr: PullRequest): Look => STATE_LOOK[pr.state === 'OPEN' && pr.draft ? 'DRAFT' : pr.state]

export const REVIEW_LABEL: Record<string, string> = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', REVIEW_REQUIRED: 'Review required' }
export const VERDICT_LABEL: Record<string, string> = { APPROVED: 'approved', CHANGES_REQUESTED: 'requested changes', COMMENTED: 'reviewed', DISMISSED: 'review dismissed' }

export const CHECK_ICON: Record<PullRequestCheck['outcome'], Omit<Look, 'label'>> = {
  pass: { Icon: CircleCheck, className: 'text-emerald-600 dark:text-emerald-500' },
  fail: { Icon: CircleX, className: 'text-destructive' },
  pending: { Icon: CircleDashed, className: 'text-amber-600 dark:text-amber-500' },
  skipped: { Icon: CircleMinus, className: 'text-muted-foreground' },
  neutral: { Icon: CircleMinus, className: 'text-muted-foreground' }
}

export const REVIEWER_LOOK: Record<PullRequestReviewer['state'], Look> = {
  requested: { label: 'Awaiting review', Icon: CircleDashed, className: 'text-amber-600 dark:text-amber-500' },
  PENDING: { label: 'Review in progress', Icon: CircleDashed, className: 'text-amber-600 dark:text-amber-500' },
  APPROVED: { label: 'Approved', Icon: CircleCheck, className: 'text-emerald-600 dark:text-emerald-500' },
  CHANGES_REQUESTED: { label: 'Requested changes', Icon: CircleX, className: 'text-destructive' },
  COMMENTED: { label: 'Commented', Icon: MessageSquare, className: 'text-muted-foreground' },
  DISMISSED: { label: 'Review dismissed', Icon: CircleMinus, className: 'text-muted-foreground' }
}

/**
 * GitHub's merge-state verdict in words, and whether merging now is worth offering. A blocked PR
 * can still be merged by an admin, so it stays offered; conflicts and drafts cannot.
 */
export const MERGE_STATE: Record<string, { hint: string; tone: 'ok' | 'warn' | 'bad'; mergeable: boolean }> = {
  CLEAN: { hint: 'Ready to merge.', tone: 'ok', mergeable: true },
  HAS_HOOKS: { hint: 'Ready to merge; the repository’s merge hooks will run.', tone: 'ok', mergeable: true },
  UNSTABLE: { hint: 'Some checks fail, but none of them is required.', tone: 'warn', mergeable: true },
  BLOCKED: { hint: 'Blocked: a required review or check is missing. Admins can still merge.', tone: 'warn', mergeable: true },
  BEHIND: { hint: 'The branch is behind its target; the repository wants it brought up to date first.', tone: 'warn', mergeable: true },
  DIRTY: { hint: 'Conflicts with the target branch. Resolve them here and push.', tone: 'bad', mergeable: false },
  DRAFT: { hint: 'A draft. Mark it ready for review before merging.', tone: 'warn', mergeable: false },
  UNKNOWN: { hint: 'GitHub is still working out whether this can merge.', tone: 'warn', mergeable: true }
}

export const TONE_CLASS = { ok: 'text-emerald-600 dark:text-emerald-500', warn: 'text-amber-600 dark:text-amber-500', bad: 'text-destructive' } as const

export const at = (iso: string): number => Date.parse(iso)

export function checksSummary(checks: PullRequestCheck[]): string {
  if (checks.length === 0) return 'No checks'
  const failed = checks.filter((c) => c.outcome === 'fail').length
  const pending = checks.filter((c) => c.outcome === 'pending').length
  if (failed) return `${plural(failed, 'check')} failing`
  if (pending) return `${plural(pending, 'check')} running`
  return `${plural(checks.length, 'check')} passed`
}

/**
 * GitHub's picture of a login, from the address GitHub serves every avatar at; on Enterprise the
 * host serves `<login>.png`. No API call: the image is fetched by the browser. When it does not
 * load — offline, a team, an account with none — the generated avatar stands in.
 */
export function GitHubAvatar({ login, name, host, className }: { login: string; name?: string | null; host: string | null; className?: string }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  const src = !host || host === 'github.com' ? `https://avatars.githubusercontent.com/${encodeURIComponent(login)}?s=64` : `https://${host}/${encodeURIComponent(login)}.png?size=64`
  if (failed) return <RandomAvatar seed={login} name={name ?? login} className={className} />
  return <img src={src} alt="" title={name ?? login} className={className} loading="lazy" onError={() => setFailed(true)} />
}

export function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="rounded-xl border border-border px-6 py-10 text-center text-sm text-muted-foreground">{children}</div>
}

/** Links in PR text leave the app: in the desktop shell a plain click would replace the window. */
export function useExternalLink() {
  const { openExternal } = usePlatform()
  return (url: string) => (event: React.MouseEvent) => {
    event.preventDefault()
    openExternal(url)
  }
}

export function Markdown({ children }: { children: string }): React.JSX.Element {
  const open = useExternalLink()
  return (
    <MessageMarkdown
      className="text-sm"
      components={{
        a: ({ href, children: label }) => (
          <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2" onClick={href ? open(href) : undefined}>
            {label}
          </a>
        )
      }}
    >
      {children}
    </MessageMarkdown>
  )
}
