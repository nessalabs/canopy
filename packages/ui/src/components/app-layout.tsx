import { useEffect, useState } from 'react'
import { ChevronRight, FolderGit2, Gauge, Moon, PanelLeft, Plus, Settings2, Sun, TreePine } from 'lucide-react'
import { Link, useLocation, useRoute } from 'wouter'

import { environmentDot, type Project, type Worktree } from '@canopy/shared'

import { AddProjectDialog } from '@/components/add-project-dialog'
import { WorktreeMenu } from '@/components/environment/worktree-menu'
import { ErrorBoundary } from '@/components/error-boundary'
import { HeaderSlotProvider, HeaderSlotTarget } from '@/components/header-slot'
import { MergedMark } from '@/components/merged-mark'
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
import { useEventsConnection } from '@/lib/events-provider'
import { readStored, writeStored } from '@/lib/local-store'
import { WORKTREE_DOT } from '@/lib/status'
import { useTheme } from '@/lib/use-theme'
import { cn } from '@/lib/utils'
import { useApi } from '@/providers/api'
import { usePlatform } from '@/providers/platform'

/** Where a tool's last full-screen choice is kept, per tool, between toggles and reloads. */
const fullKey = (id: SidePanelId): string => `canopy-side-panel-full:${id}`

/** How this tool was last left: full screen, or docked beside the screen. */
function storedFull(id: SidePanelId): boolean {
  return readStored<boolean>(fullKey(id)) === true
}

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
                icon={<StatusDot status={wt.environment.state === 'none' ? WORKTREE_DOT[wt.state] : environmentDot(wt.environment)} />}
                isActive={location === `/worktrees/${wt.id}`}
                onClick={() => navigate(`/worktrees/${wt.id}`)}
                trailing={
                  // The merged tick is the row's resting information and stays put; only the
                  // menu waits for the pointer, so the tick is never taken away while its
                  // tooltip is being read.
                  <span className="flex items-center gap-1">
                    <MergedMark worktree={wt} />
                    <WorktreeMenu worktree={wt} revealOnHover />
                  </span>
                }
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
  const connection = useEventsConnection()
  const [location, navigate] = useLocation()
  const projects = useProjects().data ?? []
  const worktrees = useWorktrees().data ?? []
  const api = useApi()
  const { titleBarInset } = usePlatform()
  // Under the traffic lights the top strip belongs to the window: it moves the window and
  // takes the title-bar double-click. Controls inside it opt back out.
  const drag = titleBarInset ? '[-webkit-app-region:drag]' : undefined
  const noDrag = titleBarInset ? '[-webkit-app-region:no-drag]' : undefined
  const [addOpen, setAddOpen] = useState(false)
  const host = new URL(api.baseUrl).host
  const [panel, setPanel] = useState<SidePanelId>()
  // Full screen keeps the split mounted and only hides the main panel, so the screen behind it
  // — a transcript's scroll, a half-typed message — is exactly where it was on the way back.
  const [panelFull, setPanelFull] = useState(false)
  // A tool reopens the way it was last left, so someone who reads files full screen isn't
  // dragging the panel wide again every time.
  useEffect(() => {
    if (panel) writeStored(fullKey(panel), panelFull)
  }, [panel, panelFull])
  const [, worktreeRoute] = useRoute('/worktrees/:id')
  const worktreeId = worktreeRoute?.id
  const open = panel && worktreeId ? { panel, worktreeId } : undefined
  // Keyed on the location so navigating away from a screen that threw clears the error.
  const main = (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <ErrorBoundary label="This screen" resetKey={location}>
        {children}
      </ErrorBoundary>
    </main>
  )

  return (
    <HeaderSlotProvider>
      <SidebarProvider className="h-svh max-h-svh overflow-hidden">
        <Sidebar collapsible={SidebarCollapsible.Icon}>
          <SidebarHeader className={cn(titleBarInset && 'pt-8', drag)}>
            <div className="flex items-center gap-2 px-2 py-1.5 group-data-[state=collapsed]/sidebar:justify-center group-data-[state=collapsed]/sidebar:px-0">
              <TreePine className="size-5 shrink-0 text-primary group-data-[state=collapsed]/sidebar:hidden" />
              <span className="text-sm font-semibold tracking-tight group-data-[state=collapsed]/sidebar:hidden">Canopy</span>
              <Badge variant="outline" className={cn('ml-auto max-w-28 truncate font-mono text-[10px] group-data-[state=collapsed]/sidebar:hidden', noDrag)} title={api.baseUrl}>
                {host}
              </Badge>
              <SidebarTrigger className={cn('group-data-[state=collapsed]/sidebar:ml-0', noDrag)}>
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
              <span className="flex min-w-0 items-center gap-1.5 truncate">
                <StatusDot status={connection === 'live' ? 'success' : 'running'} />
                <span className="truncate">canopyd · {connection === 'live' ? 'live' : 'reconnecting…'}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <Link href="/docs" className="underline-offset-2 hover:text-foreground hover:underline">
                  api
                </Link>
                <HoverAction label="Preferences" onClick={() => navigate('/settings')}>
                  <Settings2 className={cn('size-3.5', location === '/settings' && 'text-foreground')} />
                </HoverAction>
              </span>
            </p>
            <Button variant="ghost" size="icon" aria-label="Preferences" className="mx-auto hidden size-8 group-data-[state=collapsed]/sidebar:inline-flex" onClick={() => navigate('/settings')}>
              <Settings2 />
            </Button>
          </SidebarFooter>
          <SidebarRail />
        </Sidebar>
        <SidebarInset className="min-h-0">
          <header className={cn('flex h-14 shrink-0 items-center gap-3 border-b border-border px-4', titleBarInset && 'h-19 pt-5', drag)}>
            {/* The active screen's title row. Empty, it stays a drag handle for the window. */}
            <HeaderSlotTarget className={cn('flex min-w-0 flex-1 items-center', titleBarInset && '[-webkit-app-region:no-drag] empty:[-webkit-app-region:drag]')} />
            <div className={cn('ml-auto flex shrink-0 items-center gap-2', noDrag)}>
              <SidePanelButtons
                open={panel}
                disabled={!worktreeId}
                onToggle={(id) => {
                  if (panel === id) {
                    setPanel(undefined)
                    return
                  }
                  setPanel(id)
                  setPanelFull(storedFull(id))
                }}
              />
              <Button variant="ghost" size="icon" aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={toggleTheme}>
                {theme === 'dark' ? <Sun /> : <Moon />}
              </Button>
            </div>
          </header>
          {/*
            The split stays mounted whether or not a panel is open: swapping between a bare
            <main> and one nested in a panel would remount the screen, and the tab it was on,
            its scroll and its half-typed message would all go back to their defaults. Closing
            the panel hides it instead, exactly as full screen hides the main side.
          */}
          <SplitView orientation={SplitViewOrientation.Horizontal} className="min-h-0 flex-1">
            <SplitViewPanel id="main" minSize={40} className={cn('flex min-h-0 flex-col', open && panelFull && 'hidden')}>
              {main}
            </SplitViewPanel>
            <SplitViewSeparator className={open && !panelFull ? undefined : 'hidden'} />
            <SplitViewPanel
              id="side"
              defaultSize={36}
              minSize={20}
              className={cn('min-h-0 border-l border-border', panelFull && 'border-l-0', !open && 'hidden')}
            >
              {open ? (
                <SidePanel
                  id={open.panel}
                  worktreeId={open.worktreeId}
                  full={panelFull}
                  onToggleFull={() => setPanelFull((current) => !current)}
                  onClose={() => setPanel(undefined)}
                />
              ) : null}
            </SplitViewPanel>
          </SplitView>
        </SidebarInset>
        <AddProjectDialog open={addOpen} onOpenChange={setAddOpen} />
      </SidebarProvider>
    </HeaderSlotProvider>
  )
}
