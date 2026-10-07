import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Columns2, GripVertical, Maximize2, Minimize2, RotateCcw, Rows2, X } from 'lucide-react'

import {
  AppShell,
  AppShellBody,
  AppShellMain,
  AppShellPaneDragHandle,
  AppShellWorkspace,
  useAppShell
} from '@/components/composites/app-shell'
import { ErrorBoundary } from '@/components/error-boundary'
import { ShellSlot } from '@/components/shell-slots'
import { IconAction } from '@/components/icon-action'
import { PaneSplitDirection, closePane as closePaneOp, collectPanes, splitPane, type AppShellLayout, type PaneNode } from '@/lib/app-shell-layout'
import { placementOf, reinsertPane, type Placement } from '@/lib/panel-placement'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export interface PanelRequest {
  id: string
  action: 'open' | 'close' | 'toggle'
  nonce: number
}

export interface PanelDef {
  id: string
  title: string
  icon?: React.ComponentType<{ className?: string }>
  render: () => React.ReactNode
}

/** The drag payload type a panel id travels under, from outside the grid into one of its panes. */
export const VIEW_DRAG_TYPE = 'application/x-canopy-view'

/** How a pane resolves its view and what it shows with none — shared by every pane of one shell. */
interface PaneContent {
  panelFor: (viewId: string) => PanelDef | undefined
  renderEmpty?: (place: (viewId: string) => void) => React.ReactNode
}

function Pane({ pane, content }: { pane: PaneNode; content: PaneContent }): React.JSX.Element {
  const { closePane, layout, maximizePane, openView, restorePane, splitPane } = useAppShell()
  const [dropping, setDropping] = useState(false)
  const maximized = layout.workspace.maximizedPaneId === pane.id
  const panes = collectPanes(layout.workspace.root)
  const panel = pane.activeViewId ? content.panelFor(pane.activeViewId) : undefined
  const Icon = panel?.icon
  // A view already on screen stays where it is; an empty pane takes it, a full one splits for it.
  const place = (viewId: string): void => {
    if (panes.some((other) => other.activeViewId === viewId)) return
    if (pane.activeViewId) splitPane({ paneId: pane.id, direction: PaneSplitDirection.Right, views: [viewId] })
    else openView({ paneId: pane.id, viewId })
  }
  const accepts = (event: React.DragEvent): boolean => event.dataTransfer.types.includes(VIEW_DRAG_TYPE)

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-8 shrink-0 items-center gap-0.5 overflow-hidden border-b border-border bg-surface-panel pe-1">
        <AppShellPaneDragHandle
          paneId={pane.id}
          className="flex h-full min-w-0 flex-1 cursor-grab items-center gap-1.5 ps-2"
          title="Drag to move this panel"
        >
          <GripVertical aria-hidden className="size-3 shrink-0 text-muted-foreground/60" />
          {Icon ? <Icon aria-hidden className="size-3 shrink-0 text-muted-foreground" /> : null}
          <span className="truncate text-xs font-medium">{panel?.title ?? 'Empty panel'}</span>
        </AppShellPaneDragHandle>
        <IconAction
          label="Split right"
          onClick={() => splitPane({ paneId: pane.id, direction: PaneSplitDirection.Right, views: [] })}
        >
          <Columns2 aria-hidden className="size-3" />
        </IconAction>
        <IconAction
          label="Split down"
          onClick={() => splitPane({ paneId: pane.id, direction: PaneSplitDirection.Down, views: [] })}
        >
          <Rows2 aria-hidden className="size-3" />
        </IconAction>
        <IconAction
          label={maximized ? 'Restore panel' : 'Maximize panel'}
          onClick={() => (maximized ? restorePane() : maximizePane({ paneId: pane.id }))}
        >
          {maximized ? <Minimize2 aria-hidden className="size-3" /> : <Maximize2 aria-hidden className="size-3" />}
        </IconAction>
        {panes.length > 1 ? (
          <IconAction label="Close panel" onClick={() => closePane({ paneId: pane.id })}>
            <X aria-hidden className="size-3" />
          </IconAction>
        ) : null}
      </div>
      <div
        className={cn('min-h-0 flex-1 overflow-y-auto', dropping && 'bg-accent/40 ring-2 ring-ring/40 ring-inset')}
        onDragOver={(event) => {
          if (!accepts(event)) return
          event.preventDefault()
          setDropping(true)
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          setDropping(false)
          const viewId = event.dataTransfer.getData(VIEW_DRAG_TYPE)
          if (!viewId) return
          event.preventDefault()
          place(viewId)
        }}
      >
        {panel ? (
          <ErrorBoundary label={panel.title} resetKey={pane.activeViewId}>
            {panel.render()}
          </ErrorBoundary>
        ) : (
          (content.renderEmpty?.(place) ?? <p className="p-4 text-xs text-muted-foreground">Empty panel — drag another panel's grip here, or close it.</p>)
        )}
      </div>
    </div>
  )
}

function persist(storageKey: string, layout: AppShellLayout): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(layout))
  } catch {
    // best-effort persistence only
  }
}

/**
 * A user-arrangeable panel grid over nessa's AppShell workspace: panels
 * split, resize from separators, swap by dragging their grips, maximize,
 * and close — and the arrangement persists per `storageKey`.
 *
 * The reopen chips for closed panels and the reset go to the top bar's tools
 * slot, so the grid starts at its first panel rather than at a toolbar.
 */
export function PanelShell({
  storageKey,
  buildDefaultLayout,
  panels,
  resolvePanel,
  renderEmpty,
  onVisibleChange,
  request,
  className
}: {
  storageKey: string
  buildDefaultLayout: () => AppShellLayout
  panels: PanelDef[]
  /** Panels made on demand rather than listed — a view id `panels` does not name is asked here. */
  resolvePanel?: (viewId: string) => PanelDef | undefined
  /** What an empty pane offers instead of the default hint; `place` puts a view into that pane. */
  renderEmpty?: (place: (viewId: string) => void) => React.ReactNode
  /** Called with the ids of the panels currently on screen whenever the arrangement changes. */
  onVisibleChange?: (panelIds: string[]) => void
  /** A host request about one panel; each new `nonce` applies it once. */
  request?: PanelRequest
  className?: string
}): React.JSX.Element {
  const initial = useMemo<AppShellLayout>(() => {
    try {
      const stored = localStorage.getItem(storageKey)
      if (stored) return JSON.parse(stored) as AppShellLayout
    } catch {
      // fall through to the default arrangement
    }
    return buildDefaultLayout()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey])
  const [layout, setLayout] = useState<AppShellLayout>(initial)

  // Read through a ref so hosts can pass an inline builder without re-arming the reset.
  const build = useRef(buildDefaultLayout)
  build.current = buildDefaultLayout
  const resetLayout = useCallback(() => {
    try {
      localStorage.removeItem(storageKey)
    } catch {
      // storage may be unavailable; the in-memory reset still applies
    }
    setLayout(build.current())
  }, [storageKey])

  const visible = useMemo(() => collectPanes(layout.workspace.root).flatMap((pane) => (pane.activeViewId ? [pane.activeViewId] : [])), [layout])
  useEffect(() => onVisibleChange?.(visible), [visible, onVisibleChange])
  const hidden = panels.filter((panel) => !visible.includes(panel.id))

  // Where each closed panel used to sit, so reopening restores it rather than appending it.
  const closedAt = useRef(new Map<string, Placement>())
  const paneOf = (current: AppShellLayout, id: string) => collectPanes(current.workspace.root).find((pane) => pane.activeViewId === id)

  const apply = useCallback(
    (change: (current: AppShellLayout) => AppShellLayout) =>
      setLayout((current) => {
        const next = change(current)
        for (const pane of collectPanes(current.workspace.root)) {
          if (pane.activeViewId && !paneOf(next, pane.activeViewId)) {
            const placement = placementOf(current.workspace.root, pane.id)
            if (placement) closedAt.current.set(pane.activeViewId, placement)
          }
        }
        persist(storageKey, next)
        return next
      }),
    [storageKey]
  )

  /** Puts a closed panel back where it was, or beside the active pane when that spot is gone. */
  const openPanel = useCallback(
    (id: string) =>
      apply((current) => {
        if (paneOf(current, id)) return current
        const paneId = `pane-${id}-${Date.now()}`
        const remembered = closedAt.current.get(id)
        return (remembered && reinsertPane(current, id, remembered, paneId)) ?? splitPane(current, { paneId: current.workspace.activePaneId, direction: PaneSplitDirection.Right, newPaneId: paneId, views: [id] })
      }),
    [apply]
  )
  const closePanel = useCallback(
    (id: string) =>
      apply((current) => {
        const pane = paneOf(current, id)
        return pane && collectPanes(current.workspace.root).length > 1 ? closePaneOp(current, { paneId: pane.id }) : current
      }),
    [apply]
  )
  const REQUESTS: Record<PanelRequest['action'], (id: string) => void> = {
    open: openPanel,
    close: closePanel,
    toggle: (id) => (visible.includes(id) ? closePanel(id) : openPanel(id))
  }
  useEffect(() => {
    if (request) REQUESTS[request.action](request.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.id, request?.action, request?.nonce])

  const handleChange = useCallback((next: AppShellLayout) => apply(() => next), [apply])
  const content: PaneContent = { panelFor: (viewId) => panels.find((panel) => panel.id === viewId) ?? resolvePanel?.(viewId), renderEmpty }

  return (
    <div className={cn('flex flex-col overflow-hidden rounded-xl border border-border', className)}>
      <ShellSlot name="tools">
        {hidden.length > 0 ? (
          <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <span className="me-1">Hidden:</span>
            {hidden.map((panel) => (
              <Button key={panel.id} variant="outline" size="sm" className="h-6 gap-1 rounded-full px-2 text-xs" onClick={() => openPanel(panel.id)}>
                {panel.icon ? <panel.icon className="size-3" /> : null}
                {panel.title}
              </Button>
            ))}
          </span>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 shrink-0 gap-1 px-2 text-xs text-muted-foreground" onClick={resetLayout}>
              <RotateCcw className="size-3" />
              Reset layout
            </Button>
          </TooltipTrigger>
          <TooltipContent>Panels resize from their separators and move by dragging their grips — this puts everything back.</TooltipContent>
        </Tooltip>
      </ShellSlot>
      <AppShell layout={layout} onLayoutChange={handleChange} className="min-h-0 flex-1">
        <AppShellBody>
          <AppShellMain>
            <AppShellWorkspace renderPane={(pane) => <Pane pane={pane} content={content} />} />
          </AppShellMain>
        </AppShellBody>
      </AppShell>
    </div>
  )
}
