/**
 * Where a pane sat before it was closed, so it can come back to the same spot. Pure
 * functions over the nessa AppShell layout tree.
 */
import { PaneSplitDirection, SplitOrientation, createPaneNode, insertRelativeTo, type AppShellLayout, type LayoutNode, type PaneSplitDirection as Direction } from './app-shell-layout'

export interface Placement {
  /** The neighbour the pane sat next to. */
  targetId: string
  /** Which side of that neighbour the pane was on. */
  direction: Direction
  weight: number
}

/** Direction from a sibling to the pane, given the split's axis and whether the pane came after it. */
const DIRECTION: Record<SplitOrientation, [before: Direction, after: Direction]> = {
  [SplitOrientation.Horizontal]: [PaneSplitDirection.Left, PaneSplitDirection.Right],
  [SplitOrientation.Vertical]: [PaneSplitDirection.Up, PaneSplitDirection.Down]
}

/** The pane's neighbour and side within its parent split; undefined for the root or an unknown id. */
export function placementOf(root: LayoutNode, paneId: string): Placement | undefined {
  if (root.type !== 'split') return undefined
  const index = root.children.findIndex((child) => child.id === paneId)
  if (index === -1) return root.children.map((child) => placementOf(child, paneId)).find(Boolean)
  const pane = root.children[index] as LayoutNode
  const after = index > 0
  const sibling = root.children[after ? index - 1 : index + 1] as LayoutNode
  return { targetId: sibling.id, direction: DIRECTION[root.orientation][after ? 1 : 0], weight: pane.weight }
}

const hasNode = (root: LayoutNode, id: string): boolean => root.id === id || (root.type === 'split' && root.children.some((child) => hasNode(child, id)))

/** A new pane for `viewId` back beside its old neighbour; undefined when that neighbour is gone. */
export function reinsertPane(layout: AppShellLayout, viewId: string, placement: Placement, paneId: string): AppShellLayout | undefined {
  const { workspace } = layout
  if (!hasNode(workspace.root, placement.targetId)) return undefined
  const pane = createPaneNode({ id: paneId, views: [viewId], weight: placement.weight })
  const root = insertRelativeTo(workspace.root, placement.targetId, pane, placement.direction, `split:${paneId}`)
  return { ...layout, workspace: { ...workspace, root, activePaneId: paneId, recentPaneIds: [paneId, ...workspace.recentPaneIds] } }
}
