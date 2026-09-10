import { useState } from 'react'
import { Columns2, GripVertical, Maximize2, Minimize2, Rows2, X } from 'lucide-react'

import { AppShell, AppShellBody, AppShellMain, AppShellPaneDragHandle, AppShellWorkspace, useAppShell } from '@/components/composites/app-shell'
import { IconAction } from '@/components/icon-action'
import { PaneSplitDirection, collectPanes, type AppShellLayout, type PaneNode } from '@/lib/app-shell-layout'
import type { FileStop } from '@/lib/use-file-trail'

import { FilePane } from './content-pane'

/**
 * Each pane's trail: the files links were followed through, in the order they were followed,
 * with the heading each landed on. This is what Back walks, not the pane's list of open views —
 * that list keeps the order files were first opened in, which stops matching the way back the
 * moment a file is returned to and a second link followed out of it.
 */
type Trails = Record<string, FileStop[] | undefined>

/**
 * The trail as it stands for a pane showing `path`: the one recorded, so long as it still ends
 * where it led. Picking a different file from the tree leaves the trail behind, and Back with it.
 */
export function liveTrail(trail: FileStop[] | undefined, path: string): FileStop[] | undefined {
  return trail !== undefined && trail.at(-1)?.path === path ? trail : undefined
}

/** The trail after following a link out of `path`, which starts a trail if none was live. */
export function followLink(trail: FileStop[] | undefined, path: string, next: string, hash?: string): FileStop[] {
  return [...(liveTrail(trail, path) ?? [{ path }]), { path: next, hash }]
}

/** Split this file off, blow it up to the whole browser, or close it. */
function PaneActions({ pane }: { pane: PaneNode }): React.JSX.Element {
  const { closePane, layout, maximizePane, restorePane, splitPane } = useAppShell()
  const maximized = layout.workspace.maximizedPaneId === pane.id
  const only = collectPanes(layout.workspace.root).length === 1

  return (
    <span className="flex shrink-0 items-center gap-0.5">
      <IconAction label="Open another file to the right" onClick={() => splitPane({ paneId: pane.id, direction: PaneSplitDirection.Right, views: [] })}>
        <Columns2 aria-hidden className="size-3.5" />
      </IconAction>
      <IconAction label="Open another file below" onClick={() => splitPane({ paneId: pane.id, direction: PaneSplitDirection.Down, views: [] })}>
        <Rows2 aria-hidden className="size-3.5" />
      </IconAction>
      <IconAction label={maximized ? 'Restore this file' : 'Maximize this file'} pressed={maximized} onClick={() => (maximized ? restorePane() : maximizePane({ paneId: pane.id }))}>
        {maximized ? <Minimize2 aria-hidden className="size-3.5" /> : <Maximize2 aria-hidden className="size-3.5" />}
      </IconAction>
      {only ? null : (
        <IconAction label="Close this file" onClick={() => closePane({ paneId: pane.id })}>
          <X aria-hidden className="size-3.5" />
        </IconAction>
      )}
    </span>
  )
}

/** One pane: the file it holds, or the invitation to pick one when it was just split off. */
function Pane({ pane, worktreeId, trail, onTrail }: { pane: PaneNode; worktreeId: string; trail?: FileStop[]; onTrail: (trail: FileStop[]) => void }): React.JSX.Element {
  const { openView } = useAppShell()
  const path = pane.activeViewId
  const actions = <PaneActions pane={pane} />

  if (path === undefined) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-card">
        <div className="flex shrink-0 items-center gap-3 border-b border-border bg-muted/30 px-3 py-2">
          <AppShellPaneDragHandle paneId={pane.id} className="flex min-w-0 flex-1 items-center gap-1.5" title="Drag this pane onto another to swap them">
            <GripVertical aria-hidden className="size-3 shrink-0 text-muted-foreground/60" />
            <span className="min-w-0 flex-1 font-mono text-xs text-muted-foreground">Empty</span>
          </AppShellPaneDragHandle>
          {actions}
        </div>
        <p className="p-3 font-mono text-[11px] text-muted-foreground">Pick a file in the tree to read it here, or drag another pane's grip onto this one.</p>
      </div>
    )
  }

  const live = liveTrail(trail, path)
  const previous = live && live.length > 1 ? live.at(-2) : undefined

  return (
    <FilePane
      worktreeId={worktreeId}
      path={path}
      dragPaneId={pane.id}
      anchor={live?.at(-1)?.hash}
      onOpenPath={(next, hash) => {
        onTrail(followLink(trail, path, next, hash))
        openView({ viewId: next, paneId: pane.id })
      }}
      onBack={
        live === undefined || previous === undefined
          ? undefined
          : () => {
              onTrail(live.slice(0, -1))
              openView({ viewId: previous.path, paneId: pane.id })
            }
      }
      actions={actions}
      className="bg-card"
    />
  )
}

/**
 * Every file the browser has open, one nessa AppShell pane each: split a pane to read two files
 * at once, drag a pane by the grip on its path onto another to trade their places, maximize one
 * to give it the whole browser (the others stay mounted at zero width, so their scroll comes
 * back untouched), or close it. The tree opens files into the focused pane — whichever one was
 * clicked last — and a link followed inside a doc opens in that pane too, with Back returning
 * to the file it came from.
 */
export function FilePanes({ worktreeId, layout, onLayoutChange }: { worktreeId: string; layout: AppShellLayout; onLayoutChange: (layout: AppShellLayout) => void }): React.JSX.Element {
  const [trails, setTrails] = useState<Trails>({})
  return (
    <AppShell layout={layout} onLayoutChange={onLayoutChange} className="h-full">
      <AppShellBody>
        <AppShellMain>
          <AppShellWorkspace
            minPaneSize="120px"
            separatorLabel="Resize the open files"
            renderPane={(pane) => (
              <Pane pane={pane} worktreeId={worktreeId} trail={trails[pane.id]} onTrail={(trail) => setTrails((current) => ({ ...current, [pane.id]: trail }))} />
            )}
          />
        </AppShellMain>
      </AppShellBody>
    </AppShell>
  )
}
