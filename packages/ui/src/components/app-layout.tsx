import { useState } from 'react'
import { ChevronRight, FolderGit2, Gauge, Moon, PanelLeft, Plus, Settings2, Sun, TreePine } from 'lucide-react'
import { Link, useLocation, useRoute } from 'wouter'

import type { Project, Worktree } from '@canopy/shared'

import { AddProjectDialog } from '@/components/add-project-dialog'
import { SidePanel, SidePanelButtons, type SidePanelId } from '@/components/side-panel'
import { SplitView, SplitViewOrientation, SplitViewPanel, SplitViewSeparator } from '@/components/split-view'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Sidebar,
  SidebarCollapsible,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger
} from '@/components/ui/sidebar'
import { StatusDot } from '@/components/ui/status-dot'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useProjects, useWorktrees } from '@/lib/api-hooks'
import { WORKTREE_DOT } from '@/lib/status'
import { useTheme } from '@/lib/use-theme'
import { useApi } from '@/providers/api'

function HoverAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label={label}
          onClick={(event) => {
            event.stopPropagation()
            onClick()
          }}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function ProjectSection({ project, worktrees }: { project: Project; worktrees: Worktree[] }): React.JSX.Element {
  const [location, navigate] = useLocation()
  const [open, setOpen] = useState(true)

  return (
    <SidebarMenuItem
      icon={<FolderGit2 className="size-4" />}
      isActive={location.startsWith(`/projects/${project.id}`)}
      onClick={() => setOpen(!open)}
      aria-expanded={open}
      showTrailingOnHover
      trailing={
        <span className="flex items-center gap-0.5">
          <HoverAction label="New worktree" onClick={() => navigate(`/projects/${project.id}/new`)}>
            <Plus className="size-3.5" />
          </HoverAction>
          <HoverAction label="Project settings" onClick={() => navigate(`/projects/${project.id}/settings`)}>
            <Settings2 className="size-3.5" />
          </HoverAction>
        </span>
      }
      submenu={
        open ? (
          <SidebarMenu nested>
            {worktrees.map((wt) => (
              <SidebarMenuItem
                key={wt.id}
                size="sm"
                icon={<StatusDot status={WORKTREE_DOT[wt.state]} />}
                isActive={location === `/worktrees/${wt.id}`}
                onClick={() => navigate(`/worktrees/${wt.id}`)}
              >
                <span className="truncate font-mono text-xs">{wt.name}</span>
              </SidebarMenuItem>
            ))}
            <SidebarMenuItem size="sm" className="text-muted-foreground" icon={<Plus className="size-3.5" />} onClick={() => navigate(`/projects/${project.id}/new`)}>
              <span className="text-xs">New worktree</span>
            </SidebarMenuItem>
          </SidebarMenu>
        ) : null
      }
    >
      <span className="flex items-center gap-1.5">
        <span className="truncate">{project.name}</span>
        <ChevronRight className={`size-3 text-muted-foreground transition-transform [transition-duration:var(--nessa-motion-duration-fast)] ${open ? 'rotate-90' : ''}`} />
      </span>
    </SidebarMenuItem>
  )
}

export function AppLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { theme, toggleTheme } = useTheme()
  const [location, navigate] = useLocation()
  const projects = useProjects().data ?? []
  const worktrees = useWorktrees().data ?? []
  const api = useApi()
  const [addOpen, setAddOpen] = useState(false)
  const host = new URL(api.baseUrl).host
  const [panel, setPanel] = useState<SidePanelId>()
  const [, worktreeRoute] = useRoute('/worktrees/:id')
  const worktreeId = worktreeRoute?.id
  const main = <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</main>

  return (
    <SidebarProvider className="h-svh max-h-svh overflow-hidden">
      <Sidebar collapsible={SidebarCollapsible.Icon}>
        <SidebarHeader>
          <div className="flex items-center gap-2 px-2 py-1.5 group-data-[state=collapsed]/sidebar:justify-center group-data-[state=collapsed]/sidebar:px-0">
            <TreePine className="size-5 shrink-0 text-primary group-data-[state=collapsed]/sidebar:hidden" />
            <span className="text-sm font-semibold tracking-tight group-data-[state=collapsed]/sidebar:hidden">Canopy</span>
            <Badge variant="outline" className="ml-auto max-w-28 truncate font-mono text-[10px] group-data-[state=collapsed]/sidebar:hidden" title={api.baseUrl}>
              {host}
            </Badge>
            <SidebarTrigger className="group-data-[state=collapsed]/sidebar:ml-0">
              <PanelLeft />
            </SidebarTrigger>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem icon={<Gauge className="size-4" />} isActive={location === '/'} onClick={() => navigate('/')}>
                  Command Center
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {projects.map((project) => (
                  <ProjectSection key={project.id} project={project} worktrees={worktrees.filter((wt) => wt.projectId === project.id)} />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <Button variant="outline" size="sm" className="w-full group-data-[state=collapsed]/sidebar:hidden" onClick={() => setAddOpen(true)}>
            <Plus />
            Add project
          </Button>
          <Button variant="ghost" size="icon" aria-label="Add project" className="mx-auto hidden size-8 group-data-[state=collapsed]/sidebar:inline-flex" onClick={() => setAddOpen(true)}>
            <Plus />
          </Button>
          <p className="flex items-center justify-between gap-2 truncate px-2 py-1 font-mono text-[10px] text-muted-foreground group-data-[state=collapsed]/sidebar:hidden">
            <span className="truncate">canopyd · connected</span>
            <Link href="/docs" className="shrink-0 underline-offset-2 hover:text-foreground hover:underline">
              api
            </Link>
          </p>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="min-h-0">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
          <div className="ml-auto flex items-center gap-2">
            <SidePanelButtons open={panel} disabled={!worktreeId} onToggle={(id) => setPanel((current) => (current === id ? undefined : id))} />
            <Button variant="ghost" size="icon" aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={toggleTheme}>
              {theme === 'dark' ? <Sun /> : <Moon />}
            </Button>
          </div>
        </header>
        {panel && worktreeId ? (
          <SplitView orientation={SplitViewOrientation.Horizontal} className="min-h-0 flex-1">
            <SplitViewPanel id="main" minSize={40} className="flex min-h-0 flex-col">
              {main}
            </SplitViewPanel>
            <SplitViewSeparator />
            <SplitViewPanel id="side" defaultSize={36} minSize={20} className="min-h-0 border-l border-border">
              <SidePanel id={panel} worktreeId={worktreeId} onClose={() => setPanel(undefined)} />
            </SplitViewPanel>
          </SplitView>
        ) : (
          main
        )}
      </SidebarInset>
      <AddProjectDialog open={addOpen} onOpenChange={setAddOpen} />
    </SidebarProvider>
  )
}
