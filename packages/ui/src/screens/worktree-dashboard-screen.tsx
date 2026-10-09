import { useEffect, useState } from 'react'
import { Boxes, FileDiff, Sparkles } from 'lucide-react'
import { useLocation } from 'wouter'

import type { Worktree } from '@canopy/shared'

import { AgentTab } from '@/components/agent/agent-tab'
import { DestroyWorktreeDialog } from '@/components/environment/destroy-worktree-dialog'
import { EnvironmentTab } from '@/components/environment/environment-tab'
import { WorktreeActions } from '@/components/environment/worktree-actions'
import { WorktreeStatus, WorktreeStatusTools } from '@/components/environment/worktree-status'
import { GitTab } from '@/components/git/git-tab'
import { ShellSlot } from '@/components/shell-slots'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useProjects, useWorktree } from '@/lib/api-hooks'
import { forgetLinkQuery, linkQuery, parseGitLink, parseTab, type DashboardTab, type GitPane } from '@/lib/environment-ui'
import { useHotkeys } from '@/lib/use-hotkeys'
import { useWorktreeAgent } from '@/lib/use-worktree-agent'
import { cn } from '@/lib/utils'

const TABS = [
  { value: 'environment', label: 'Environment', icon: Boxes },
  { value: 'agent', label: 'Agent', icon: Sparkles },
  { value: 'git', label: 'Git', icon: FileDiff }
] as const satisfies readonly { value: DashboardTab; label: string; icon: React.ComponentType }[]

/** Sections whose content is a padded page of panels, rather than a flush full-bleed view. */
const PADDED: ReadonlySet<DashboardTab> = new Set(['environment'])

/**
 * The worktree's three sections as one pill strip in the top bar's centre. The active one always
 * keeps its label; the others drop to their icons on a narrow bar — a container query, since the
 * strip renders inside the bar.
 */
function SectionSwitcher({ tab, dirty }: { tab: DashboardTab; dirty: number }): React.JSX.Element {
  return (
    <TabsList variant="pill" className="shrink-0 [&>[data-slot=tabs-trigger]]:min-h-6! [&>[data-slot=tabs-trigger]]:flex-none! [&>[data-slot=tabs-trigger]]:text-xs">
      {TABS.map(({ value, label, icon: Icon }, index) => (
        <TabsTrigger key={value} value={value} icon={<Icon />} badge={value === 'git' && dirty ? dirty : undefined} title={`${label}  ${index + 1}`}>
          <span className={value === tab ? undefined : 'hidden @5xl:inline'}>{label}</span>
        </TabsTrigger>
      ))}
    </TabsList>
  )
}

function DashboardBody({ worktree, projectName }: { worktree: Worktree; projectName: string }): React.JSX.Element {
  const [, navigate] = useLocation()
  const [tab, setTab] = useState<DashboardTab>(() => parseTab(linkQuery()) ?? (worktree.environment.configured ? 'environment' : 'git'))
  const [gitPane, setGitPane] = useState<GitPane>(() => parseGitLink(linkQuery()).pane ?? 'changes')
  // The Git tab reads the same link while this first render mounts it; after that it is spent.
  useEffect(forgetLinkQuery, [])
  useHotkeys(Object.fromEntries(TABS.map(({ value }, index) => [String(index + 1), () => setTab(value)])))
  const [destroyOpen, setDestroyOpen] = useState(false)
  const agent = useWorktreeAgent(worktree)
  const openChanges = (): void => {
    setTab('git')
    setGitPane('changes')
  }

  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as DashboardTab)} className={cn('flex min-h-0 flex-1 flex-col', PADDED.has(tab) && 'p-3')}>
      {/* The portal keeps the strip inside <Tabs>, so Radix still owns its selection. */}
      <ShellSlot name="section">
        <SectionSwitcher tab={tab} dirty={worktree.status?.dirtyTotal ?? 0} />
      </ShellSlot>
      {PADDED.has(tab) ? (
        <ShellSlot name="actions">
          <WorktreeActions worktree={worktree} />
        </ShellSlot>
      ) : null}
      <ShellSlot name="status">
        <WorktreeStatus worktree={worktree} projectName={projectName} onDestroy={() => setDestroyOpen(true)} onOpenChanges={openChanges} />
      </ShellSlot>
      <ShellSlot name="statusEnd">
        <WorktreeStatusTools worktree={worktree} onOpenAgent={() => setTab('agent')} />
      </ShellSlot>
      <TabsContent value="environment" className="flex min-h-0 flex-1 flex-col">
        <EnvironmentTab worktree={worktree} />
      </TabsContent>
      <TabsContent value="git" className="flex min-h-0 flex-1 flex-col">
        <GitTab worktree={worktree} agent={agent} pane={gitPane} onPaneChange={setGitPane} />
      </TabsContent>
      <TabsContent value="agent" className="flex min-h-0 flex-1 flex-col">
        <AgentTab worktree={worktree} agent={agent} />
      </TabsContent>
      <DestroyWorktreeDialog worktree={worktree} open={destroyOpen} onOpenChange={setDestroyOpen} onDestroyed={() => navigate('/')} />
    </Tabs>
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
