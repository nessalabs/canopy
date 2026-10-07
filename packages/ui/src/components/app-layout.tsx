import { useEffect, useState } from 'react'
import { ChevronRight, Folder, FolderOpen, Gauge, GitBranch, GitFork, PanelLeft, Plus, Settings2, TreePine } from 'lucide-react'
import { useLocation, useRoute } from 'wouter'

import { environmentDot, type Project, type Worktree } from '@canopy/shared'

import { AddProjectDialog } from '@/components/add-project-dialog'
import { WorktreeMenu } from '@/components/environment/worktree-menu'
import { RecentWorktreeStatus } from '@/components/environment/worktree-status'
import { ErrorBoundary } from '@/components/error-boundary'
import { MergedMark } from '@/components/merged-mark'
import { ShellSlotProvider, ShellSlotTarget } from '@/components/shell-slots'
import { SidePanel, type SidePanelId } from '@/components/side-panel'
import { SplitView, SplitViewOrientation, SplitViewPanel, SplitViewSeparator } from '@/components/split-view'
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
  SidebarTrigger,
  useSidebar
} from '@/components/ui/sidebar'
import { StatusBar } from '@/components/status-bar'
import { StatusDot } from '@/components/ui/status-dot'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useProjects, useWorktrees } from '@/lib/api-hooks'
import { readStored, writeStored } from '@/lib/local-store'
import { WORKTREE_DOT } from '@/lib/status'
import { useFonts } from '@/lib/use-fonts'
import { useHotkeys } from '@/lib/use-hotkeys'
import { cn } from '@/lib/utils'
import { usePlatform } from '@/providers/platform'

/** Where the last worktree on screen is remembered, for the status bar on every other screen. */
const RECENT_WORKTREE_KEY = 'canopy-recent-worktree'

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

/**
 * A worktree row's leading mark: a branch for the main checkout, a fork for every other worktree,
 * with the status dot pinned to its corner. The dot's ring follows the row's own background so it
 * reads as cut out of the icon whether the row is resting, hovered or active.
 */
function WorktreeIcon({ worktree }: { worktree: Worktree }): React.JSX.Element {
  const Icon = worktree.isMain ? GitBranch : GitFork
  // A checkout that is not there outranks whatever its environment last said it was doing: a
  // stopped environment must never make a gone worktree look ordinary.
  const status = worktree.state === 'missing' || worktree.environment.state === 'none' ? WORKTREE_DOT[worktree.state] : environmentDot(worktree.environment)
  return (
    <span className="relative inline-flex">
      <Icon className="size-3.5 text-muted-foreground" />
      <StatusDot
        status={status}
        className="absolute -right-0.5 -bottom-0.5 size-1.5 ring-2 ring-sidebar group-hover/menu-button:ring-sidebar-accent group-data-[active=true]/menu-button:ring-sidebar-accent"
      />
    </span>
  )
}

function ProjectSection({ project, worktrees }: { project: Project; worktrees: Worktree[] }): React.JSX.Element {
  const [location, navigate] = useLocation()
  const [open, setOpen] = useState(true)

  return (
    <SidebarMenuItem
      icon={open ? <FolderOpen className="size-4" /> : <Folder className="size-4" />}
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
                icon={<WorktreeIcon worktree={wt} />}
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
                {/* The main checkout is named after its folder, which says nothing; the branch
                    it has checked out is what the row is really about. */}
                <span className="truncate font-mono text-xs">{wt.isMain ? (wt.branch ?? wt.name) : wt.name}</span>
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

/**
 * The top bar: the screen's own tabs on the left, the worktree's section switcher in the centre,
 * and the screen's controls then its one primary action on the right. The outer columns share
 * the leftover width evenly, which is what keeps the centre centred whatever the sides measure.
 */
function TopBar(): React.JSX.Element {
  const { titleBarInset } = usePlatform()
  const { open } = useSidebar()
  // Under the traffic lights the strip belongs to the window: it moves the window and takes the
  // title-bar double-click. Controls inside it opt back out.
  const noDrag = titleBarInset ? '[-webkit-app-region:no-drag]' : undefined
  return (
    <header
      className={cn(
        '@container grid h-10 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 border-b border-border bg-surface-panel px-2',
        titleBarInset && 'h-12 pt-2 [-webkit-app-region:drag]',
        // With the sidebar away the traffic lights sit over the bar's left edge.
        titleBarInset && !open && 'pl-20'
      )}
    >
      <ShellSlotTarget name="view" className={cn('flex min-w-0 items-center gap-2 self-stretch overflow-hidden ps-2', noDrag)} />
      <ShellSlotTarget name="section" className={cn('flex items-center justify-center', noDrag)} />
      <div className="flex min-w-0 items-center justify-end gap-2">
        {/* One line tall and wrapping: a control that does not fit wraps out of sight whole,
            rather than being squeezed; the Git menu carries the same switches. */}
        <ShellSlotTarget name="tools" className={cn('flex h-7 min-w-0 flex-1 flex-wrap content-start items-center justify-end gap-x-2 gap-y-4 overflow-hidden', noDrag)} />
        <ShellSlotTarget name="actions" className={cn('flex shrink-0 items-center gap-1 empty:hidden', noDrag)} />
      </div>
    </header>
  )
}

export function AppLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  useFonts()
  const [location, navigate] = useLocation()
  const projects = useProjects().data ?? []
  const worktrees = useWorktrees().data ?? []
  const { titleBarInset } = usePlatform()
  const drag = titleBarInset ? '[-webkit-app-region:drag]' : undefined
  const noDrag = titleBarInset ? '[-webkit-app-region:no-drag]' : undefined
  const [addOpen, setAddOpen] = useState(false)
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
  // A hand-typed `#/worktrees/x?tab=git` keeps its query in the hash, and so in the match.
  const worktreeId = worktreeRoute?.id.split('?')[0]
  // The last worktree on screen, so the status bar keeps its logs and terminal everywhere else.
  const [recentId, setRecentId] = useState(() => readStored<string>(RECENT_WORKTREE_KEY))
  useEffect(() => {
    if (!worktreeId) return
    setRecentId(worktreeId)
    writeStored(RECENT_WORKTREE_KEY, worktreeId)
  }, [worktreeId])
  const recent = !worktreeId && recentId && worktrees.some((wt) => wt.id === recentId) ? recentId : undefined
  const open = panel && worktreeId ? { panel, worktreeId } : undefined
  const toggleFiles = (): void => {
    if (!worktreeId) return
    if (panel === 'files') return setPanel(undefined)
    setPanel('files')
    setPanelFull(storedFull('files'))
  }
  useHotkeys({ '\\': toggleFiles })
  // Keyed on the location so navigating away from a screen that threw clears the error.
  const main = (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <ErrorBoundary label="This screen" resetKey={location}>
        {children}
      </ErrorBoundary>
    </main>
  )

  return (
    <ShellSlotProvider>
      <SidebarProvider className="h-svh max-h-svh min-h-0 flex-col overflow-hidden" keyboardShortcut={{ key: '[' }}>
        <div className="flex min-h-0 flex-1">
          {/* Its own height is the screen's; here it shares the column with the status bar. */}
          <Sidebar collapsible={SidebarCollapsible.Offcanvas} className="h-full">
            <SidebarHeader className={cn(titleBarInset && 'pt-8', drag)}>
              <div className="flex items-center gap-2 px-2 py-1">
                <TreePine className="size-5 shrink-0 text-primary" />
                <span className="text-sm font-semibold tracking-tight">Canopy</span>
                <SidebarTrigger className={cn('ml-auto text-muted-foreground', noDrag)} aria-label="Hide sidebar  [">
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
            <SidebarFooter className="border-t border-border">
              <Button variant="outline" size="sm" className="w-full" onClick={() => setAddOpen(true)}>
                <Plus />
                Add project
              </Button>
            </SidebarFooter>
          </Sidebar>
          <SidebarInset className="min-h-0">
            <TopBar />
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
              <SplitViewPanel id="side" defaultSize={22} minSize={14} className={cn('min-h-0 border-l border-border', panelFull && 'border-l-0', !open && 'hidden')}>
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
        </div>
        {recent ? <RecentWorktreeStatus id={recent} /> : null}
        <StatusBar filesOpen={panel === 'files' && Boolean(worktreeId)} filesDisabled={!worktreeId} onToggleFiles={toggleFiles} />
        <AddProjectDialog open={addOpen} onOpenChange={setAddOpen} />
      </SidebarProvider>
    </ShellSlotProvider>
  )
}
