import { describe, expect, it } from 'vitest'

import { PaneSplitDirection, closePane, collectPanes, createAppShellLayout, splitPane } from '../src/lib/app-shell-layout'
import { placementOf, reinsertPane } from '../src/lib/panel-placement'

function threeColumns() {
  let layout = createAppShellLayout({ initialPaneId: 'a', views: ['A'], openDocks: [] })
  layout = splitPane(layout, { paneId: 'a', direction: PaneSplitDirection.Right, newPaneId: 'b', views: ['B'] })
  return splitPane(layout, { paneId: 'b', direction: PaneSplitDirection.Right, newPaneId: 'c', views: ['C'] })
}

describe('panel placement', () => {
  it('describes a pane by its left/up neighbour, or right/down for the first child', () => {
    const { workspace } = threeColumns()
    expect(placementOf(workspace.root, 'c')).toMatchObject({ targetId: 'b', direction: PaneSplitDirection.Right })
    expect(placementOf(workspace.root, 'a')).toMatchObject({ targetId: 'b', direction: PaneSplitDirection.Left })
    expect(placementOf(workspace.root, 'zzz')).toBeUndefined()
  })

  it('puts a closed pane back where it was', () => {
    const before = threeColumns()
    const placement = placementOf(before.workspace.root, 'a')!
    const closed = closePane(before, { paneId: 'a' })
    expect(collectPanes(closed.workspace.root).map((p) => p.activeViewId)).toEqual(['B', 'C'])
    const restored = reinsertPane(closed, 'A', placement, 'a2')!
    expect(collectPanes(restored.workspace.root).map((p) => p.activeViewId)).toEqual(['A', 'B', 'C'])
    expect(restored.workspace.activePaneId).toBe('a2')
  })

  it('gives up when the old neighbour is gone', () => {
    const layout = createAppShellLayout({ initialPaneId: 'only', views: ['X'], openDocks: [] })
    expect(reinsertPane(layout, 'A', { targetId: 'gone', direction: PaneSplitDirection.Right, weight: 1 }, 'a2')).toBeUndefined()
  })
})
