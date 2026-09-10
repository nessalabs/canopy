import { useEffect, useMemo, useState } from 'react'

import { ExplorerShell } from '@/components/git/explorer-shell'
import { FileOpenDialog, isOpenFileShortcut } from '@/components/git/file-open-dialog'
import { FilePanes } from '@/components/git/file-panes'
import { preloadCodeEditor } from '@/components/git/file-viewer'
import { WorktreeTree } from '@/components/git/file-tree'
import { FileDiffPath } from '@/components/ui/file-diff-list'
import { APP_SHELL_LAYOUT_VERSION, collectPanes, createAppShellLayout, normalizeAppShellLayout, openView, type AppShellLayout } from '@/lib/app-shell-layout'
import { readStored, writeStored } from '@/lib/local-store'

/** Where one worktree's open files are kept between panel toggles and reloads. */
const layoutKey = (worktreeId: string): string => `canopy-file-browser:${worktreeId}`

/**
 * The files this worktree had open, or a single empty pane. Closing the panel unmounts the
 * browser — the tree, its listings and every open file — so the arrangement is read back from
 * storage rather than held in memory; anything the layout model no longer accepts is discarded.
 */
function initialLayout(worktreeId: string): AppShellLayout {
  const stored = readStored<AppShellLayout>(layoutKey(worktreeId))
  if (stored?.version === APP_SHELL_LAYOUT_VERSION) {
    try {
      return normalizeAppShellLayout(stored)
    } catch {
      // fall through to a fresh pane
    }
  }
  return createAppShellLayout({ initialPaneId: 'file-pane', openDocks: [] })
}

/** The file the pane the tree opens into is showing, so the tree can mark it. */
function activePath(layout: AppShellLayout): string | undefined {
  const { activePaneId, root } = layout.workspace
  return collectPanes(root).find((pane) => pane.id === activePaneId)?.activeViewId
}

/**
 * The whole worktree in the side panel: the lazy tree, and the files picked from it — markdown
 * as rendered prose, everything else as source. Files open into the focused pane, and a pane
 * splits so two of them can be read side by side or one blown up to the whole panel. ⌘O opens
 * any file in the worktree by name, without walking the tree down to it.
 */
export function FileBrowser({ worktreeId }: { worktreeId: string }): React.JSX.Element {
  const [layout, setLayout] = useState<AppShellLayout>(() => initialLayout(worktreeId))
  const [opening, setOpening] = useState(false)
  const selected = useMemo(() => activePath(layout), [layout])
  const open = (path: string): void => setLayout((current) => openView(current, { viewId: path }))

  useEffect(() => writeStored(layoutKey(worktreeId), layout), [worktreeId, layout])

  // The panel being open is as good a sign as any that a file is about to be: fetch the editor now.
  useEffect(preloadCodeEditor, [])

  // The shortcut belongs to the browser, so it works from anywhere in the panel — and only
  // while the panel is open, which is when "open a file" means anything.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isOpenFileShortcut(event)) return
      event.preventDefault()
      setOpening(true)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <>
      <ExplorerShell
        className="h-full"
        treeLabel="Worktree files"
        overlayHeader={selected ? <FileDiffPath path={selected} className="min-w-0 flex-1 font-mono text-xs" /> : null}
        tree={<WorktreeTree worktreeId={worktreeId} selected={selected} onSelect={open} className="h-full" />}
        content={<FilePanes worktreeId={worktreeId} layout={layout} onLayoutChange={setLayout} />}
      />
      <FileOpenDialog worktreeId={worktreeId} open={opening} onOpenChange={setOpening} onOpen={open} />
    </>
  )
}
