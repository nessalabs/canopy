import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Columns2, GripVertical, Maximize2, Minimize2, Rows2, X } from 'lucide-react'

import {
  AppShell,
  AppShellBody,
  AppShellMain,
  AppShellPaneDragHandle,
  AppShellWorkspace,
  useAppShell
} from '@/components/composites/app-shell'
import { ErrorBoundary } from '@/components/error-boundary'
import { IconAction } from '@/components/icon-action'
import { PaneSplitDirection, closePane as closePaneOp, collectPanes, splitPane, type AppShellLayout, type PaneNode } from '@/lib/app-shell-layout'
import { placementOf, reinsertPane, type Placement } from '@/lib/panel-placement'
import { Button } from '@/components/ui/button'
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

function Pane({ pane, panels }: { pane: PaneNode; panels: PanelDef[] }): React.JSX.Element {
  const { closePane, layout, maximizePane, restorePane, splitPane } = useAppShell()
  const maximized = layout.workspace.maximizedPaneId === pane.id
  const paneCount = collectPanes(layout.workspace.root).length
  const panel = panels.find((entry) => entry.id === pane.activeViewId)
  const Icon = panel?.icon

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex h-8 shrink-0 items-center gap-0.5 overflow-hidden border-b border-border bg-muted/40 pe-1">
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
        {paneCount > 1 ? (
          <IconAction label="Close panel" onClick={() => closePane({ paneId: pane.id })}>
            <X aria-hidden className="size-3" />
          </IconAction>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {panel ? (
          <ErrorBoundary label={panel.title} resetKey={pane.activeViewId}>
            {panel.render()}
          </ErrorBoundary>
        ) : (
          <p className="p-4 text-xs text-muted-foreground">
            Empty panel — drag another panel's grip here, or close it.
          </p>
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
 * and close — and the arrangement persists per `storageKey`. `resetToken`
 * increments discard the stored layout.
 */
export function PanelShell({
  storageKey,
  buildDefaultLayout,
  panels,
  resetToken = 0,
  onVisibleChange,
  request,
  className
}: {
  storageKey: string
  buildDefaultLayout: () => AppShellLayout
  panels: PanelDef[]
  resetToken?: number
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

  useEffect(() => {
    if (resetToken === 0) return
    try {
      localStorage.removeItem(storageKey)
    } catch {
      // storage may be unavailable; the in-memory reset still applies
    }
    setLayout(buildDefaultLayout())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetToken])

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

  return (
    <div className={cn('flex flex-col overflow-hidden rounded-xl border border-border', className)}>
      {hidden.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1 border-b border-border bg-muted/30 px-2 py-1 text-xs text-muted-foreground">
          <span className="me-1">Hidden:</span>
          {hidden.map((panel) => (
            <Button key={panel.id} variant="outline" size="sm" className="h-6 gap-1 px-2 text-xs" onClick={() => openPanel(panel.id)}>
              {panel.icon ? <panel.icon className="size-3" /> : null}
              {panel.title}
            </Button>
          ))}
        </div>
      ) : null}
      <AppShell layout={layout} onLayoutChange={handleChange} className="min-h-0 flex-1">
        <AppShellBody>
          <AppShellMain>
            <AppShellWorkspace renderPane={(pane) => <Pane pane={pane} panels={panels} />} />
          </AppShellMain>
        </AppShellBody>
      </AppShell>
    </div>
  )
}
