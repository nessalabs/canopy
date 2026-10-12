import { closePane, closeView, collectPanes, type AppShellLayout } from '@/lib/app-shell-layout'

/**
 * A saved arrangement with only the views that still mean something: each view `keep` turns
 * down leaves its pane, and a pane left with nothing closes — unless it is the last one. What a
 * layout saved by an older build, or by a reader whose tabs did not survive the reload, would
 * otherwise come back as: empty panels.
 */
export function pruneLayout(layout: AppShellLayout, keep: (viewId: string) => boolean): AppShellLayout {
  let next = layout
  for (const pane of collectPanes(layout.workspace.root)) {
    for (const viewId of pane.views.filter((id) => !keep(id))) next = closeView(next, { viewId, paneId: pane.id })
  }
  for (const pane of collectPanes(next.workspace.root)) {
    if (pane.views.length === 0 && collectPanes(next.workspace.root).length > 1) next = closePane(next, { paneId: pane.id })
  }
  return next
}
