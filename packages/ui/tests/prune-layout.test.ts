import { describe, expect, it } from 'vitest'

import { PaneSplitDirection, collectPanes, createAppShellLayout, splitPane } from '@/lib/app-shell-layout'
import { pruneLayout } from '@/lib/prune-layout'

const threePanes = () => {
  const one = createAppShellLayout({ initialPaneId: 'p1', views: ['sessions'], openDocks: [] })
  const two = splitPane(one, { paneId: 'p1', direction: PaneSplitDirection.Right, newPaneId: 'p2', views: ['conversation'] })
  return splitPane(two, { paneId: 'p2', direction: PaneSplitDirection.Right, newPaneId: 'p3', views: ['reader'] })
}

const shown = (layout: ReturnType<typeof threePanes>) => collectPanes(layout.workspace.root).map((pane) => pane.activeViewId ?? null)

describe('pruneLayout', () => {
  it('closes the pane of a view that no longer means anything', () => {
    expect(shown(pruneLayout(threePanes(), (id) => id !== 'reader'))).toEqual(['sessions', 'conversation'])
  })

  it('leaves a layout whose views all mean something as it was', () => {
    const layout = threePanes()
    expect(pruneLayout(layout, () => true)).toBe(layout)
  })

  it('keeps the last pane, empty, rather than none', () => {
    expect(shown(pruneLayout(threePanes(), () => false))).toEqual([null])
  })
})
