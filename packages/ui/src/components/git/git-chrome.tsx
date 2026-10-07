import { ArrowLeftRight, Columns2, Copy, ExternalLink, GitCommitHorizontal, GitMerge, GitPullRequest, MoreHorizontal, Send, Upload } from 'lucide-react'

import type { Against, Worktree } from '@canopy/shared'

import type { DiffMode } from '@/components/worktree-diff'
import { ShellSlot } from '@/components/shell-slots'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { SegmentedControl, SegmentedControlOption } from '@/components/ui/segmented-control'
import { TabsList, TabsTrigger } from '@/components/ui/tabs'
import { usePushBranch } from '@/lib/api-hooks'
import type { GitPane } from '@/lib/environment-ui'
import { mergeAffordance } from '@/lib/status'
import { usePlatform } from '@/providers/platform'

/** The id the Changes commit box's form carries, so the top bar's Commit can submit it from afar. */
export const commitFormId = (worktreeId: string): string => `commit-box-${worktreeId}`

/** Git's four views as underline tabs in the top bar's left slot; render inside Git's `<Tabs>`. */
export function GitViewTabs({ dirty, comments, onPrefetchPr }: { dirty: number; comments: number; onPrefetchPr: () => void }): React.JSX.Element {
  const badge = (count: number) => (count ? <span className="font-mono text-[11px] text-muted-foreground">{count}</span> : null)
  return (
    <ShellSlot name="view">
      <TabsList className="h-full min-w-0 shrink self-stretch border-b-0 text-xs [scrollbar-width:none] [&>[data-slot=tabs-trigger]]:min-h-0! [&>[data-slot=tabs-trigger]]:gap-1">
        <TabsTrigger value="changes" title="Changes  ⇧1">
          Changes {badge(dirty)}
        </TabsTrigger>
        <TabsTrigger value="history" title="History  ⇧2">
          History
        </TabsTrigger>
        <TabsTrigger value="pr" title="Pull request  ⇧3" onPointerEnter={onPrefetchPr} onFocus={onPrefetchPr}>
          Pull request
        </TabsTrigger>
        <TabsTrigger value="comments" title="Comments  ⇧4">
          Comments {badge(comments)}
        </TabsTrigger>
      </TabsList>
    </ShellSlot>
  )
}

/**
 * How the diff on screen is drawn and what Changes compares against, in the top bar's tools
 * slot. The slot drops whatever no longer fits on its one line, and the Git menu carries the
 * same two switches, so a narrow window loses the shortcut and never the choice.
 */
export function DiffTools({
  mode,
  onModeChange,
  against,
  onAgainstChange,
  baseBranch
}: {
  mode: DiffMode
  onModeChange: (mode: DiffMode) => void
  /** Present on Changes only. */
  against?: Against
  onAgainstChange: (against: Against) => void
  baseBranch: string
}): React.JSX.Element {
  return (
    <ShellSlot name="tools">
      <SegmentedControl value={mode} onValueChange={(value) => onModeChange(value as DiffMode)} aria-label="Diff layout" className="text-xs">
        <SegmentedControlOption value="unified">Unified</SegmentedControlOption>
        <SegmentedControlOption value="split">Split</SegmentedControlOption>
      </SegmentedControl>
      {against ? (
        <SegmentedControl value={against} onValueChange={(value) => onAgainstChange(value as Against)} aria-label="Compare against" className="text-xs">
          <SegmentedControlOption value="head">vs HEAD</SegmentedControlOption>
          <SegmentedControlOption value="base">vs {baseBranch}</SegmentedControlOption>
        </SegmentedControl>
      ) : null}
    </ShellSlot>
  )
}

/** The one primary action a Git view offers in the top bar. */
interface Cta {
  label: string
  icon: React.ComponentType
  variant?: 'default' | 'outline'
  disabled?: boolean
  /** Submits this form instead of running `onClick` — Changes' commit box. */
  form?: string
  onClick?: () => void
}

export interface GitActionsProps {
  worktree: Worktree
  pane: GitPane
  onPaneChange: (pane: GitPane) => void
  mode: DiffMode
  onModeChange: (mode: DiffMode) => void
  against: Against
  onAgainstChange: (against: Against) => void
  /** Local comments and picked GitHub threads not yet sent to an agent. */
  pendingReview: number
  sending: boolean
  onSendForReview: () => void
  onMerge: () => void
  /** The branch's pull request on GitHub, once it has been read. */
  prUrl?: string
}

/** Each view's primary action: commit what is checked, open the PR, send the comments. */
const CTA_FOR: Record<GitPane, (props: GitActionsProps, openExternal: (url: string) => void) => Cta | undefined> = {
  changes: ({ worktree, against }) => (against === 'head' ? { label: 'Commit', icon: GitCommitHorizontal, form: commitFormId(worktree.id) } : undefined),
  history: () => undefined,
  pr: ({ prUrl }, openExternal) => (prUrl ? { label: 'Open on GitHub', icon: ExternalLink, variant: 'outline', onClick: () => openExternal(prUrl) } : undefined),
  comments: ({ pendingReview, sending, onSendForReview }) => ({ label: 'Send for review', icon: Send, disabled: pendingReview === 0 || sending, onClick: onSendForReview })
}

/**
 * The top bar's far right while Git is open: the view's primary action, then everything else
 * Git can do from anywhere in the tab — push, commit, the pull request, merge, review — and the
 * diff switches the tools slot may have had to drop.
 */
export function GitActions(props: GitActionsProps): React.JSX.Element {
  const { worktree, pane, onPaneChange, mode, onModeChange, against, onAgainstChange, pendingReview, sending, onSendForReview, onMerge, prUrl } = props
  const { openExternal } = usePlatform()
  const push = usePushBranch(worktree.id)
  const merge = mergeAffordance(worktree)
  const cta = CTA_FOR[pane](props, openExternal)
  const branch = worktree.branch

  return (
    <ShellSlot name="actions">
      {cta ? (
        <Button size="sm" variant={cta.variant ?? 'default'} className="h-7 text-xs" type={cta.form ? 'submit' : 'button'} form={cta.form} disabled={cta.disabled} onClick={cta.onClick}>
          <cta.icon />
          <span className="hidden @3xl:inline">{cta.label}</span>
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-7" aria-label="Git actions">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuItem disabled={branch === null || push.isPending} onSelect={() => push.mutate()}>
            <Upload /> {push.isPending ? 'Pushing…' : 'Push'}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onPaneChange('changes')}>
            <GitCommitHorizontal /> Commit…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onPaneChange('pr')}>
            <GitPullRequest /> {prUrl ? 'Pull request' : 'Create pull request'}
          </DropdownMenuItem>
          {merge.shown ? (
            <DropdownMenuItem disabled={!merge.enabled} title={merge.hint} onSelect={onMerge}>
              <GitMerge /> {merge.label}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem disabled={pendingReview === 0 || sending} onSelect={onSendForReview}>
            <Send /> Send {pendingReview || ''} for review
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onModeChange(mode === 'split' ? 'unified' : 'split')}>
            <Columns2 /> {mode === 'split' ? 'Unified diff' : 'Split diff'}
          </DropdownMenuItem>
          {pane === 'changes' ? (
            <DropdownMenuItem onSelect={() => onAgainstChange(against === 'head' ? 'base' : 'head')}>
              <ArrowLeftRight /> Compare against {against === 'head' ? worktree.baseBranch : 'HEAD'}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={branch === null} onSelect={() => void navigator.clipboard?.writeText(branch ?? '').catch(() => undefined)}>
            <Copy /> Copy branch name
          </DropdownMenuItem>
          {prUrl ? (
            <DropdownMenuItem onSelect={() => openExternal(prUrl)}>
              <ExternalLink /> Open on GitHub
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </ShellSlot>
  )
}
