import { useState } from 'react'
import { Columns2, GripVertical, Maximize2, Minimize2, Rows2, X } from 'lucide-react'

import { AppShell, AppShellBody, AppShellMain, AppShellPaneDragHandle, AppShellWorkspace, useAppShell } from '@/components/composites/app-shell'
import { IconAction } from '@/components/icon-action'
import { PaneSplitDirection, collectPanes, type AppShellLayout, type PaneNode } from '@/lib/app-shell-layout'

import { FilePane } from './content-pane'

/** The heading a doc link named, and the pane and file it was meant for. */
interface Anchor {
  paneId: string
  path: string
  hash?: string
}

/** The file a pane is showing, and the one it would go back to — the previous file opened here. */
function history(pane: PaneNode): { path?: string; previous?: string } {
  const path = pane.activeViewId
  const index = path === undefined ? -1 : pane.views.indexOf(path)
  return { path, previous: index > 0 ? pane.views[index - 1] : undefined }
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
function Pane({ pane, worktreeId, anchor, onAnchor }: { pane: PaneNode; worktreeId: string; anchor?: Anchor; onAnchor: (anchor: Anchor) => void }): React.JSX.Element {
  const { openView } = useAppShell()
  const { path, previous } = history(pane)
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

  return (
    <FilePane
      worktreeId={worktreeId}
      path={path}
      dragPaneId={pane.id}
      anchor={anchor?.paneId === pane.id && anchor.path === path ? anchor.hash : undefined}
      onOpenPath={(next, hash) => {
        onAnchor({ paneId: pane.id, path: next, hash })
        openView({ viewId: next, paneId: pane.id })
      }}
      onBack={previous === undefined ? undefined : () => openView({ viewId: previous, paneId: pane.id })}
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
  const [anchor, setAnchor] = useState<Anchor>()
  return (
    <AppShell layout={layout} onLayoutChange={onLayoutChange} className="h-full">
      <AppShellBody>
        <AppShellMain>
          <AppShellWorkspace
            minPaneSize="120px"
            separatorLabel="Resize the open files"
            renderPane={(pane) => <Pane pane={pane} worktreeId={worktreeId} anchor={anchor} onAnchor={setAnchor} />}
          />
        </AppShellMain>
      </AppShellBody>
    </AppShell>
  )
}
