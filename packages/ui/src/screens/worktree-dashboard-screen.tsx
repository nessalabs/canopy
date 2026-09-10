import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Check, Copy, FileDiff, GitBranch, LayoutPanelLeft, RotateCw } from 'lucide-react'
import { useLocation } from 'wouter'

import type { ReviewRequest, Worktree } from '@canopy/shared'

import { AgentTab } from '@/components/agent/agent-tab'
import { EnvironmentTab } from '@/components/environment/environment-tab'
import { WorktreeActions } from '@/components/environment/worktree-actions'
import { ErrorNote } from '@/components/error-note'
import { GitDiffTab } from '@/components/git/git-diff-tab'
import { HeaderSlot } from '@/components/header-slot'
import { ResourcesTab } from '@/components/resources/resources-tab'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useComments, useDestroyWorktreeWith, useProjects, useWorktree } from '@/lib/api-hooks'
import { parseTab, uptime, type DashboardTab } from '@/lib/environment-ui'
import { plural } from '@/lib/format'
import { ENV_STATE_BADGE } from '@/lib/status'
import type { ReviewTarget } from '@/lib/use-agent-turn'
import { useWorktreeAgent } from '@/lib/use-worktree-agent'

function DestroyDialog({ worktree, open, onOpenChange }: { worktree: Worktree; open: boolean; onOpenChange: (open: boolean) => void }): React.JSX.Element {
  const [, navigate] = useLocation()
  const destroy = useDestroyWorktreeWith()
  const [deleteBranch, setDeleteBranch] = useState(false)
  const dirty = worktree.status?.dirtyTotal ?? 0
  const branch = worktree.branch

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Destroy {worktree.name}?</DialogTitle>
          <DialogDescription>
            Removes the worktree at <span className="font-mono">{worktree.path}</span>: this stops every service, frees its ports, and drops its database forks.
            {dirty > 0 ? <span className="mt-2 block text-destructive">This worktree has {plural(dirty, 'uncommitted change')} — they will be lost.</span> : null}
          </DialogDescription>
        </DialogHeader>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={deleteBranch} disabled={worktree.isMain || !branch || destroy.isPending} onChange={(event) => setDeleteBranch(event.target.checked)} />
          <span>
            Delete branch <span className="font-mono">{branch ?? '(detached)'}</span>
          </span>
        </label>
        <ErrorNote error={destroy.error} />
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="sm" disabled={destroy.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            variant="destructive"
            size="sm"
            disabled={destroy.isPending}
            onClick={() => destroy.mutate({ id: worktree.id, force: dirty > 0, deleteBranch }, { onSuccess: () => navigate('/') })}
          >
            {destroy.isPending ? <RotateCw className="animate-spin" /> : null}
            {destroy.isPending ? 'Destroying…' : 'Destroy worktree'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The worktree's identity line. It renders into the app's top bar (see HeaderSlot), so the
 * dashboard below it starts at the tabs — everything here has to hold one row and truncate.
 * The lifecycle actions sit on the tab row below, not here.
 */
function Header({ worktree, projectName }: { worktree: Worktree; projectName: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const env = worktree.environment
  const badge = ENV_STATE_BADGE[env.state]
  const status = worktree.status
  const up = uptime(env.startedAt)

  const copyPath = (): void => {
    void navigator.clipboard?.writeText(worktree.path).catch(() => undefined)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <div className="flex shrink-0 items-center gap-2">
        <h1 className="max-w-64 truncate font-mono text-sm font-semibold tracking-tight">{worktree.name}</h1>
        <Badge variant={badge.variant} className="text-[10px]">
          {badge.label}
        </Badge>
        {up ? <span className="font-mono text-[11px] text-muted-foreground">up {up}</span> : null}
        {worktree.isMain ? (
          <Badge variant="outline" className="text-[10px]">
            main checkout
          </Badge>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-x-3 font-mono text-[11px] text-muted-foreground">
        <span className="hidden shrink-0 items-center gap-1 md:flex">
          <GitBranch className="size-3" />
          {projectName} · {worktree.branch ?? 'detached'}
        </span>
        {status?.ahead !== null && status?.ahead !== undefined ? (
          <span className="hidden shrink-0 items-center gap-0.5 md:flex">
            <ArrowUp className="size-3" />
            {status.ahead}
            <ArrowDown className="ml-1 size-3" />
            {status.behind}
          </span>
        ) : null}
        {status && status.dirtyTotal > 0 ? (
          <span className="hidden shrink-0 items-center gap-1 text-foreground md:flex">
            <FileDiff className="size-3" />
            {status.dirtyTotal} dirty
          </span>
        ) : null}
        {env.stateReason ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="max-w-72 shrink truncate text-destructive">{env.stateReason}</span>
            </TooltipTrigger>
            <TooltipContent>{env.stateReason}</TooltipContent>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className="hidden min-w-0 cursor-pointer items-center gap-1 hover:text-foreground lg:flex" onClick={copyPath}>
              {copied ? <Check className="size-3 shrink-0" /> : <Copy className="size-3 shrink-0" />}
              <span className="truncate">{worktree.path}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>Copy the worktree path</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

function DashboardBody({ worktree, projectName }: { worktree: Worktree; projectName: string }): React.JSX.Element {
  const [tab, setTab] = useState<DashboardTab>(() => parseTab(window.location.hash) ?? (worktree.environment.configured ? 'environment' : 'gitdiff'))
  const [destroyOpen, setDestroyOpen] = useState(false)
  const [resetToken, setResetToken] = useState(0)
  const agent = useWorktreeAgent(worktree)
  const comments = useComments(worktree.id).data ?? []
  // Selecting a session resets the turn state on the next render, so the review is queued
  // and sent once the chosen conversation (or the new-session composer) is the active one.
  const [pending, setPending] = useState<{ target: ReviewTarget; request: Omit<ReviewRequest, 'provider' | 'sessionId'>; summary: string }>()
  const ready = pending && (pending.target.sessionId ? agent.selected?.sessionId === pending.target.sessionId : agent.fresh === pending.target.provider)
  useEffect(() => {
    if (!pending || !ready) return
    setPending(undefined)
    void agent.turn.sendReview(pending.target, pending.request, pending.summary)
  }, [pending, ready])

  const sendForReview = (target: ReviewTarget, note: string | undefined): void => {
    const unsent = comments.filter((comment) => !comment.sent)
    if (target.sessionId) agent.select({ provider: target.provider, sessionId: target.sessionId })
    else agent.startSession(target.provider)
    setTab('agent')
    setPending({ target, request: { commentIds: unsent.map((c) => c.id), note }, summary: `Review request: ${plural(unsent.length, 'comment')} on ${worktree.branch ?? worktree.name}` })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-3 pt-3 pb-4 md:px-6 md:pt-4 md:pb-5">
      <HeaderSlot>
        <Header worktree={worktree} projectName={projectName} />
      </HeaderSlot>
      <Tabs value={tab} onValueChange={(value) => setTab(value as DashboardTab)} className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-2">
          <TabsList>
            <TabsTrigger value="environment">Environment</TabsTrigger>
            <TabsTrigger value="gitdiff">Git Diff{worktree.status?.dirtyTotal ? ` · ${worktree.status.dirtyTotal}` : ''}</TabsTrigger>
            <TabsTrigger value="agent">Agent</TabsTrigger>
            <TabsTrigger value="resources">Resources</TabsTrigger>
          </TabsList>
          <div className="flex min-w-0 shrink items-center justify-end gap-1.5">
            {tab === 'environment' ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={() => setResetToken((token) => token + 1)}>
                    <LayoutPanelLeft className="size-3.5" />
                    Reset layout
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Panels resize from their separators and move by dragging their grips — this puts everything back.</TooltipContent>
              </Tooltip>
            ) : null}
            <WorktreeActions worktree={worktree} onDestroy={() => setDestroyOpen(true)} />
          </div>
        </div>
        <TabsContent value="environment" className="mt-3">
          <EnvironmentTab worktree={worktree} resetToken={resetToken} />
        </TabsContent>
        <TabsContent value="gitdiff" className="mt-3">
          <GitDiffTab worktree={worktree} agent={agent} onSendForReview={sendForReview} />
        </TabsContent>
        <TabsContent value="agent" className="mt-3 flex min-h-0 flex-1 flex-col">
          <AgentTab worktree={worktree} agent={agent} />
        </TabsContent>
        <TabsContent value="resources" className="mt-3">
          <ResourcesTab worktree={worktree} />
        </TabsContent>
      </Tabs>
      <DestroyDialog worktree={worktree} open={destroyOpen} onOpenChange={setDestroyOpen} />
    </div>
  )
}

export function WorktreeDashboardScreen({ id }: { id: string }): React.JSX.Element {
  const [, navigate] = useLocation()
  const worktree = useWorktree(id)
  const projects = useProjects().data ?? []

  if (worktree.isPending) return <p className="p-6 font-mono text-xs text-muted-foreground">Loading worktree…</p>
  if (worktree.error || !worktree.data) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-3 px-6 py-16 text-center">
        <p className="text-sm text-muted-foreground">That worktree doesn't exist (anymore).</p>
        <Button variant="outline" size="sm" onClick={() => navigate('/')}>
          Back to Command Center
        </Button>
      </div>
    )
  }
  // Keyed so the per-worktree tab, layout and log-stream state start fresh when the id changes.
  return <DashboardBody key={worktree.data.id} worktree={worktree.data} projectName={projects.find((p) => p.id === worktree.data.projectId)?.name ?? ''} />
}
