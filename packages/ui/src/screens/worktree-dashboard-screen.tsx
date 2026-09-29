import { useEffect, useState } from 'react'
import { Activity, Boxes, Check, ChevronDown, Copy, FileDiff, Sparkles } from 'lucide-react'
import { useLocation } from 'wouter'

import { environmentDot, type ReviewRequest, type Worktree } from '@canopy/shared'

import { AgentTab } from '@/components/agent/agent-tab'
import { DestroyWorktreeDialog } from '@/components/environment/destroy-worktree-dialog'
import { EnvironmentTab } from '@/components/environment/environment-tab'
import { WorktreeActions } from '@/components/environment/worktree-actions'
import { GitTab } from '@/components/git/git-tab'
import { HeaderSlot } from '@/components/header-slot'
import { ResourcesTab } from '@/components/resources/resources-tab'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { StatusDot } from '@/components/ui/status-dot'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useComments, useProjects, useWorktree } from '@/lib/api-hooks'
import { parseTab, uptime, type DashboardTab } from '@/lib/environment-ui'
import { plural } from '@/lib/format'
import { ENV_STATE_BADGE, mergedLabel, WORKTREE_DOT } from '@/lib/status'
import type { ReviewTarget } from '@/lib/use-agent-turn'
import { useWorktreeAgent } from '@/lib/use-worktree-agent'

/** One `label: value` line in the identity menu. */
function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4 px-2 py-1 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate font-mono">{children}</span>
    </div>
  )
}

/**
 * The worktree's name, and — behind it — everything the row has no width for: state, branch
 * and the base it was cut from, uptime, ahead/behind, uncommitted files and the path. The
 * branch lives here rather than inline: the row is shared with the tab strip
 * and the lifecycle actions, and one menu costs less than three chips fighting for width. The
 * state keeps a presence in the row as the dot the sidebar uses; the words for it ("Not
 * provisioned", "Running") are worth a menu row, not the width they cost inline.
 */
function Identity({ worktree, projectName }: { worktree: Worktree; projectName: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const env = worktree.environment
  const badge = ENV_STATE_BADGE[env.state]
  const status = worktree.status
  const merged = mergedLabel(worktree)
  const up = uptime(env.startedAt)

  const copyPath = (): void => {
    void navigator.clipboard?.writeText(worktree.path).catch(() => undefined)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <DropdownMenu>
      <h1 className="flex min-w-0 shrink items-center">
        <DropdownMenuTrigger className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 hover:bg-accent">
          <StatusDot status={env.state === 'none' ? WORKTREE_DOT[worktree.state] : environmentDot(env)} aria-label={badge.label} />
          <span className="truncate font-mono text-sm font-semibold tracking-tight">{worktree.name}</span>
          <ChevronDown aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
      </h1>
      <DropdownMenuContent align="start" className="w-80">
        <Row label="State">{badge.label}</Row>
        <Row label="Project">{projectName}</Row>
        <Row label="Branch">{worktree.branch ?? 'detached'}</Row>
        <Row label="Base">{worktree.baseBranch}</Row>
        {worktree.isMain ? <Row label="Checkout">main</Row> : null}
        {merged ? <Row label="Merged">{merged.merged ? 'yes' : 'no'}</Row> : null}
        {up ? <Row label="Uptime">{up}</Row> : null}
        {status?.ahead !== null && status?.ahead !== undefined ? (
          <Row label="Ahead / behind">
            {status.ahead} / {status.behind}
          </Row>
        ) : null}
        {status ? <Row label="Uncommitted">{plural(status.dirtyTotal, 'file')}</Row> : null}
        <DropdownMenuSeparator />
        {/* Held open so the copy reports back where it was asked for. */}
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault()
            copyPath()
          }}
        >
          {copied ? <Check /> : <Copy />}
          <span className="min-w-0 truncate font-mono text-xs">{copied ? 'Copied' : worktree.path}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const TABS = [
  { value: 'environment', label: 'Environment', icon: Boxes },
  { value: 'git', label: 'Git', icon: FileDiff },
  { value: 'agent', label: 'Agent', icon: Sparkles },
  { value: 'resources', label: 'Resources', icon: Activity }
] as const satisfies readonly { value: DashboardTab; label: string; icon: React.ComponentType }[]

function DashboardBody({ worktree, projectName }: { worktree: Worktree; projectName: string }): React.JSX.Element {
  const [, navigate] = useLocation()
  const [tab, setTab] = useState<DashboardTab>(() => parseTab(window.location.hash) ?? (worktree.environment.configured ? 'environment' : 'git'))
  const [destroyOpen, setDestroyOpen] = useState(false)
  const env = worktree.environment
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
    <div className="flex min-h-0 flex-1 flex-col px-3 pt-3 pb-3 md:px-6 md:pt-4 md:pb-4">
      <Tabs value={tab} onValueChange={(value) => setTab(value as DashboardTab)} className="flex min-h-0 flex-1 flex-col">
        {/*
          Identity, tabs and actions share the top bar's single row: the pill strip reads as
          part of that bar rather than as a second one, and the body starts at the tab content.
          The portal keeps the tab strip inside <Tabs>, so Radix still owns its selection.
        */}
        <HeaderSlot>
          {/*
            Three groups, and the two outer ones share the leftover width evenly (flex-1 over a
            zero basis) — that is what centres the strip, whatever the identity and the actions
            happen to measure. Even sharing is the preference, not a cap: the actions floor at
            their own width (min-w-fit), so a wide run of them — URL, Stop, Restart, a progress
            word — takes what it needs from the identity side and nudges the strip left rather
            than being clipped mid-button. Only the identity clips; the strip never shrinks.
          */}
          <div className="@container flex min-w-0 flex-1 items-center gap-3">
            <div className="flex min-w-0 flex-1 basis-0 items-center gap-3 overflow-hidden">
              <Identity worktree={worktree} projectName={projectName} />
              {env.stateReason ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="min-w-0 truncate font-mono text-[11px] text-destructive">{env.stateReason}</span>
                  </TooltipTrigger>
                  <TooltipContent>{env.stateReason}</TooltipContent>
                </Tooltip>
              ) : null}
            </div>
            {/*
              Never squeezed: a crushed pill strip clips its labels rather than dropping them.
              The pill variant stretches its tabs to equal widths, which is right for a strip
              that owns its row and wrong here — the widest label ("Environment") then overruns
              its quarter and swallows the gap after its icon. Each tab sizes to its own
              content instead, and only `!` outranks the variant's own child selector.
            */}
            <TabsList variant="pill" className="shrink-0 [&>[data-slot=tabs-trigger]]:flex-none!">
              {TABS.map(({ value, label, icon: Icon }) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  icon={<Icon />}
                  badge={value === 'git' && worktree.status?.dirtyTotal ? worktree.status.dirtyTotal : undefined}
                >
                  {/* Below @3xl the row can only afford the icons. */}
                  <span className="hidden @3xl:inline">{label}</span>
                </TabsTrigger>
              ))}
            </TabsList>
            <div className="flex min-w-fit flex-1 basis-0 justify-end">
              <WorktreeActions worktree={worktree} onDestroy={() => setDestroyOpen(true)} />
            </div>
          </div>
        </HeaderSlot>
        <TabsContent value="environment">
          <EnvironmentTab worktree={worktree} />
        </TabsContent>
        <TabsContent value="git" className="flex min-h-0 flex-1 flex-col">
          <GitTab worktree={worktree} agent={agent} onSendForReview={sendForReview} />
        </TabsContent>
        <TabsContent value="agent" className="flex min-h-0 flex-1 flex-col">
          <AgentTab worktree={worktree} agent={agent} />
        </TabsContent>
        <TabsContent value="resources">
          <ResourcesTab worktree={worktree} />
        </TabsContent>
      </Tabs>
      <DestroyWorktreeDialog worktree={worktree} open={destroyOpen} onOpenChange={setDestroyOpen} onDestroyed={() => navigate('/')} />
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
