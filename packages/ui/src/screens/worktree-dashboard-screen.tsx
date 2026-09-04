import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Check, Copy, FileDiff, GitBranch, MoreHorizontal } from 'lucide-react'
import { useLocation } from 'wouter'

import type { ReviewRequest, Worktree } from '@canopy/shared'

import { AgentTab } from '@/components/agent/agent-tab'
import { ComingSoon } from '@/components/coming-soon'
import { ErrorNote } from '@/components/error-note'
import { GitDiffTab } from '@/components/git/git-diff-tab'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useComments, useDestroyWorktree, useProjects, useWorktree } from '@/lib/api-hooks'
import { plural } from '@/lib/format'
import { WORKTREE_BADGE } from '@/lib/status'
import type { ReviewTarget } from '@/lib/use-agent-turn'
import { useWorktreeAgent } from '@/lib/use-worktree-agent'

type Tab = 'environment' | 'gitdiff' | 'agent' | 'resources'

function DestroyDialog({ worktree, open, onOpenChange }: { worktree: Worktree; open: boolean; onOpenChange: (open: boolean) => void }): React.JSX.Element {
  const [, navigate] = useLocation()
  const destroy = useDestroyWorktree()
  const dirty = worktree.status?.dirtyTotal ?? 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Destroy {worktree.name}?</DialogTitle>
          <DialogDescription>
            Removes the worktree at <span className="font-mono">{worktree.path}</span>. The branch <span className="font-mono">{worktree.branch}</span> itself is kept.
            {dirty > 0 ? <span className="mt-2 block text-destructive">This worktree has {plural(dirty, 'uncommitted change')} — they will be lost.</span> : null}
          </DialogDescription>
        </DialogHeader>
        <ErrorNote error={destroy.error} />
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="sm">
              Cancel
            </Button>
          </DialogClose>
          <Button variant="destructive" size="sm" disabled={destroy.isPending} onClick={() => destroy.mutate({ id: worktree.id, force: dirty > 0 }, { onSuccess: () => navigate('/') })}>
            Destroy worktree
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Header({ worktree, projectName, onDestroy }: { worktree: Worktree; projectName: string; onDestroy: () => void }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const badge = WORKTREE_BADGE[worktree.state]
  const status = worktree.status

  const copyPath = (): void => {
    void navigator.clipboard?.writeText(worktree.path).catch(() => undefined)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-mono text-xl font-semibold tracking-tight">{worktree.name}</h1>
          <Badge variant={badge.variant} className="text-[10px]">
            {badge.label}
          </Badge>
          {worktree.isMain ? (
            <Badge variant="outline" className="text-[10px]">
              main checkout
            </Badge>
          ) : null}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <GitBranch className="size-3" />
            {projectName} · {worktree.branch ?? 'detached'}
          </span>
          {status?.ahead !== null && status?.ahead !== undefined ? (
            <span className="flex items-center gap-0.5">
              <ArrowUp className="size-3" />
              {status.ahead}
              <ArrowDown className="ml-1 size-3" />
              {status.behind}
            </span>
          ) : null}
          {status && status.dirtyTotal > 0 ? (
            <span className="flex items-center gap-1 text-foreground">
              <FileDiff className="size-3" />
              {status.dirtyTotal} dirty
            </span>
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="flex cursor-pointer items-center gap-1 hover:text-foreground" onClick={copyPath}>
                {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                {worktree.path}
              </button>
            </TooltipTrigger>
            <TooltipContent>Copy the worktree path</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8" aria-label="More actions">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem variant="destructive" disabled={worktree.isMain} onSelect={onDestroy}>
            Destroy worktree…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function DashboardBody({ worktree, projectName }: { worktree: Worktree; projectName: string }): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('gitdiff')
  const [destroyOpen, setDestroyOpen] = useState(false)
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
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-3 py-4 md:px-6 md:py-5">
      <Header worktree={worktree} projectName={projectName} onDestroy={() => setDestroyOpen(true)} />
      <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)} className="flex min-h-0 flex-1 flex-col">
        <TabsList>
          <TabsTrigger value="environment">Environment</TabsTrigger>
          <TabsTrigger value="gitdiff">Git Diff{worktree.status?.dirtyTotal ? ` · ${worktree.status.dirtyTotal}` : ''}</TabsTrigger>
          <TabsTrigger value="agent">Agent</TabsTrigger>
          <TabsTrigger value="resources">Resources</TabsTrigger>
        </TabsList>
        <TabsContent value="environment" className="mt-3">
          <ComingSoon title="Environment" detail="Services, ports, databases, logs and env vars from canopy.yaml — the next iteration." />
        </TabsContent>
        <TabsContent value="gitdiff" className="mt-3">
          <GitDiffTab worktree={worktree} agent={agent} onSendForReview={sendForReview} />
        </TabsContent>
        <TabsContent value="agent" className="mt-3 flex min-h-0 flex-1 flex-col">
          <AgentTab worktree={worktree} agent={agent} />
        </TabsContent>
        <TabsContent value="resources" className="mt-3">
          <ComingSoon title="Resources" detail="btop-style CPU and memory per service, once services run under Canopy." />
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
  return <DashboardBody worktree={worktree.data} projectName={projects.find((p) => p.id === worktree.data.projectId)?.name ?? ''} />
}
