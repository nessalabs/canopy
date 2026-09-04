import {
  AppShellDockSide,
  PaneDropRegion,
  PaneSplitDirection,
  SplitOrientation,
  splitDirectionIsAfter,
  splitDirectionToOrientation,
} from "./layout-options"
import {
  collectPanes,
  findNode,
  formatWeight,
  normalizeAppShellLayout,
} from "./layout-normalize"
import {
  APP_SHELL_LAYOUT_VERSION,
  type AppShellLayout,
  type LayoutNode,
  type LayoutNodeId,
  type PaneNode,
  type PaneViewId,
  type SplitNode,
  type WorkspaceLayout,
} from "./layout-types"

/** Values accepted for creating one workspace pane. */
interface CreatePaneOptions {
  /** Unique id for the pane. */
  id: LayoutNodeId
  /**
   * Share of the parent split's main axis.
   * @defaultValue 1
   */
  weight?: number
  /**
   * Ordered views hosted by the pane.
   * @defaultValue []
   */
  views?: readonly PaneViewId[]
  /** The view the pane presents. Defaults to the first provided view. */
  activeViewId?: PaneViewId
}

/**
 * Creates one pane node.
 *
 * @param options - The pane id, optional weight, and hosted views.
 * @returns A pane node ready for insertion into a workspace tree.
 */
function createPaneNode(options: CreatePaneOptions): PaneNode {
  const views = options.views ?? []
  const activeViewId = options.activeViewId ?? views[0]

  return {
    type: "pane",
    id: options.id,
    weight: options.weight ?? 1,
    views,
    ...(activeViewId !== undefined ? { activeViewId } : {}),
  }
}

/** Values accepted for creating a default layout document. */
interface CreateAppShellLayoutOptions {
  /**
   * Id of the initial pane.
   * @defaultValue "pane-1"
   */
  initialPaneId?: LayoutNodeId
  /**
   * Views hosted by the initial pane.
   * @defaultValue []
   */
  views?: readonly PaneViewId[]
  /**
   * Initial pixel sizes per dock side.
   * @defaultValue left/right 288, bottom 240
   */
  dockSizes?: Partial<Record<AppShellDockSide, number>>
  /**
   * Dock sides that start open.
   * @defaultValue [AppShellDockSide.Left]
   */
  openDocks?: readonly AppShellDockSide[]
}

/**
 * Creates a minimal, normalized layout document with a single pane.
 *
 * @param options - Initial pane identity, views, and dock configuration.
 * @returns A complete layout document ready to render.
 */
function createAppShellLayout(
  options: CreateAppShellLayoutOptions = {},
): AppShellLayout {
  const initialPaneId = options.initialPaneId ?? "pane-1"
  const openDocks = options.openDocks ?? [AppShellDockSide.Left]

  const dockState = (side: AppShellDockSide, defaultSize: number) => ({
    open: openDocks.includes(side),
    size: options.dockSizes?.[side] ?? defaultSize,
  })

  return {
    version: APP_SHELL_LAYOUT_VERSION,
    docks: {
      [AppShellDockSide.Left]: dockState(AppShellDockSide.Left, 288),
      [AppShellDockSide.Right]: dockState(AppShellDockSide.Right, 288),
      [AppShellDockSide.Bottom]: dockState(AppShellDockSide.Bottom, 240),
    },
    workspace: {
      root: createPaneNode({ id: initialPaneId, views: options.views }),
      activePaneId: initialPaneId,
      recentPaneIds: [initialPaneId],
    },
  }
}

/**
 * Puts a new node next to an existing one. There are only two cases, and
 * they are the same rule Zed and VS Code use:
 *
 * Case 1 — the new node goes the same way the parent already flows.
 * It slides in as one more sibling, and the target shares its space:
 *
 * ```txt
 *   ┌─────┬─────┐   insert N        ┌──┬──┬─────┐
 *   │  A  │  B  │   right of A  →   │A │N │  B  │
 *   └─────┴─────┘                   └──┴──┴─────┘
 *    A ½    B ½                     A ¼  N ¼  B ½
 * ```
 *
 * Case 2 — the new node goes across the parent's flow.
 * The target gets wrapped in a small new split holding both:
 *
 * ```txt
 *   ┌─────┬─────┐   insert N        ┌─────┬─────┐
 *   │  A  │  B  │   below A     →   │  A  │     │
 *   └─────┴─────┘                   ├─────┤  B  │
 *                                   │  N  │     │
 *                                   └─────┴─────┘
 * ```
 *
 * @param root - The tree root.
 * @param targetId - The node the insertion is relative to.
 * @param node - The node to insert.
 * @param direction - Where the inserted node lands relative to the target.
 * @param wrapSplitId - Id used when a new split node must be created.
 * @returns The new root, or the original root when the target is absent.
 */
function insertRelativeTo(
  root: LayoutNode,
  targetId: LayoutNodeId,
  node: LayoutNode,
  direction: PaneSplitDirection,
  wrapSplitId: LayoutNodeId,
): LayoutNode {
  const orientation = splitDirectionToOrientation(direction)
  const after = splitDirectionIsAfter(direction)

  /**
   * Wraps the matched target in a new split sharing the target's weight.
   *
   * @param target - The node being split.
   * @returns The replacement split node.
   */
  const wrapTarget = (target: LayoutNode): SplitNode => {
    const halves: LayoutNode[] = [
      { ...target, weight: 0.5 },
      { ...node, weight: 0.5 },
    ]

    return {
      type: "split",
      id: wrapSplitId,
      weight: target.weight,
      orientation,
      children: after ? halves : [halves[1], halves[0]],
    }
  }

  if (root.id === targetId) {
    return wrapTarget(root)
  }

  /**
   * Rebuilds one subtree with the insertion applied.
   *
   * @param current - The subtree root being visited.
   * @returns The rebuilt subtree, or the same reference when untouched.
   */
  const visit = (current: LayoutNode): LayoutNode => {
    if (current.type === "pane") {
      return current
    }

    const targetIndex = current.children.findIndex(
      (child) => child.id === targetId,
    )

    if (targetIndex !== -1) {
      const target = current.children[targetIndex]

      if (current.orientation === orientation) {
        // Case 1: same direction. The new node becomes a sibling, and the
        // two of them split the target's old space in half — nobody else
        // moves.
        const half = formatWeight(target.weight / 2)
        const children = [...current.children]
        children[targetIndex] = { ...target, weight: half }
        children.splice(after ? targetIndex + 1 : targetIndex, 0, {
          ...node,
          weight: half,
        })

        return { ...current, children }
      }

      const children = [...current.children]
      children[targetIndex] = wrapTarget(target)

      return { ...current, children }
    }

    const children = current.children.map(visit)
    const unchanged = children.every(
      (child, index) => child === current.children[index],
    )

    return unchanged ? current : { ...current, children }
  }

  return visit(root)
}

/**
 * Removes a node from the tree. The freed space goes to the neighbor on the
 * left (or the right, when the removed node was first) — not spread across
 * everyone — so closing a pane exactly undoes the split that created it:
 *
 * ```txt
 *   ┌──┬──┬─────┐    remove N     ┌─────┬─────┐
 *   │A │N │  B  │        →        │  A  │  B  │
 *   └──┴──┴─────┘                 └─────┴─────┘
 *   A ¼  N ¼  B ½                  A ½    B ½
 * ```
 *
 * @param root - The tree root.
 * @param id - The id of the node to remove.
 * @returns The remaining root (null when the tree empties) and the removed
 * node (null when the id is absent).
 */
function removeNode(
  root: LayoutNode,
  id: LayoutNodeId,
): { root: LayoutNode | null; removed: LayoutNode | null } {
  if (root.id === id) {
    return { root: null, removed: root }
  }

  let removed: LayoutNode | null = null

  /**
   * Rebuilds one subtree with the removal applied.
   *
   * @param current - The subtree root being visited.
   * @returns The rebuilt subtree, or the same reference when untouched.
   */
  const visit = (current: LayoutNode): LayoutNode => {
    if (current.type === "pane" || removed) {
      return current
    }

    const index = current.children.findIndex((child) => child.id === id)

    if (index !== -1) {
      removed = current.children[index]
      const children = current.children.filter((_, at) => at !== index)
      const heirIndex = Math.max(0, index - 1)

      if (children[heirIndex]) {
        children[heirIndex] = {
          ...children[heirIndex],
          weight: formatWeight(children[heirIndex].weight + removed.weight),
        }
      }

      return { ...current, children }
    }

    const children = current.children.map(visit)
    const unchanged = children.every(
      (child, at) => child === current.children[at],
    )

    return unchanged ? current : { ...current, children }
  }

  const nextRoot = visit(root)

  return { root: removed ? nextRoot : root, removed }
}

/**
 * Moves a pane id to the front of the recently-used list.
 *
 * @example
 * ```txt
 * (["a", "b", "c"], "b") → ["b", "a", "c"]
 * ```
 *
 * @param recentPaneIds - The current recently-used list, newest first.
 * @param paneId - The pane id to move to the front.
 * @returns The list with the pane first and duplicates removed.
 */
function promoteRecentPane(
  recentPaneIds: readonly LayoutNodeId[],
  paneId: LayoutNodeId,
): LayoutNodeId[] {
  return [paneId, ...recentPaneIds.filter((id) => id !== paneId)]
}

/** Values accepted when splitting a pane. */
interface SplitPaneOptions {
  /** The pane being split. */
  paneId: LayoutNodeId
  /** Where the new pane lands relative to the split pane. */
  direction: PaneSplitDirection
  /** Unique id for the new pane. */
  newPaneId: LayoutNodeId
  /**
   * Views hosted by the new pane.
   * @defaultValue []
   */
  views?: readonly PaneViewId[]
  /** The view the new pane presents. Defaults to the first provided view. */
  activeViewId?: PaneViewId
  /**
   * Id used when a new split node must wrap the target.
   * @defaultValue "split:" + newPaneId
   */
  newSplitId?: LayoutNodeId
}

/**
 * Splits a pane: a new pane appears beside it (see `insertRelativeTo` for
 * the two placement cases) and immediately becomes the focused pane.
 *
 * @example
 * ```txt
 * one pane "a", split right with new pane "b":
 *
 *   ┌───────┐        ┌───┬───┐
 *   │   a   │   →    │ a │ b │      focus moves to b
 *   └───────┘        └───┴───┘
 * ```
 *
 * @param layout - The current layout document.
 * @param options - The target pane, direction, and new pane identity.
 * @returns The next document, or the same document when the target pane is
 * missing or the new id is already taken.
 */
function splitPane(
  layout: AppShellLayout,
  options: SplitPaneOptions,
): AppShellLayout {
  const { workspace } = layout
  const target = findNode(workspace.root, options.paneId)
  const wrapSplitId = options.newSplitId ?? `split:${options.newPaneId}`

  // Both new ids must be unused — a duplicate id would make every later
  // lookup, resize, and removal ambiguous.
  if (
    !target ||
    target.type !== "pane" ||
    findNode(workspace.root, options.newPaneId) ||
    findNode(workspace.root, wrapSplitId)
  ) {
    return layout
  }

  const newPane = createPaneNode({
    id: options.newPaneId,
    views: options.views,
    activeViewId: options.activeViewId,
  })

  const root = insertRelativeTo(
    workspace.root,
    options.paneId,
    newPane,
    options.direction,
    wrapSplitId,
  )

  return normalizeAppShellLayout({
    ...layout,
    workspace: {
      ...workspace,
      root,
      activePaneId: options.newPaneId,
      recentPaneIds: promoteRecentPane(
        workspace.recentPaneIds,
        options.newPaneId,
      ),
    },
  })
}

/**
 * Closes a pane. Its space goes back to the neighbor it was split from
 * (see `removeNode`), and focus moves to whichever surviving pane the user
 * touched most recently. The last remaining pane never closes.
 *
 * @param layout - The current layout document.
 * @param options - The pane to close.
 * @returns The next document, or the same document when the pane is missing
 * or is the last one.
 */
function closePane(
  layout: AppShellLayout,
  options: { paneId: LayoutNodeId },
): AppShellLayout {
  const { workspace } = layout
  const panes = collectPanes(workspace.root)

  if (panes.length <= 1 || !panes.some((pane) => pane.id === options.paneId)) {
    return layout
  }

  const { root } = removeNode(workspace.root, options.paneId)

  if (!root) {
    return layout
  }

  const { maximizedPaneId, ...rest } = workspace

  return normalizeAppShellLayout({
    ...layout,
    workspace: {
      ...rest,
      root,
      recentPaneIds: workspace.recentPaneIds.filter(
        (id) => id !== options.paneId,
      ),
      ...(maximizedPaneId !== undefined && maximizedPaneId !== options.paneId
        ? { maximizedPaneId }
        : {}),
    },
  })
}

/**
 * Turns a drop region into the matching split direction.
 *
 * @param region - An edge drop region (never Center).
 * @returns The direction a pane dropped on that edge splits toward.
 */
function dropRegionToDirection(
  region: Exclude<PaneDropRegion, typeof PaneDropRegion.Center>,
): PaneSplitDirection {
  switch (region) {
    case PaneDropRegion.Top:
      return PaneSplitDirection.Up
    case PaneDropRegion.Bottom:
      return PaneSplitDirection.Down
    case PaneDropRegion.Left:
      return PaneSplitDirection.Left
    case PaneDropRegion.Right:
      return PaneSplitDirection.Right
  }
}

/** Values accepted when moving a pane. */
interface MovePaneOptions {
  /** The pane being moved. */
  paneId: LayoutNodeId
  /** The pane it is dropped on. */
  targetPaneId: LayoutNodeId
  /** Where on the target it lands. */
  region: PaneDropRegion
}

/**
 * Moves a pane somewhere else in the tree. This is simply "remove, then
 * insert" — the same building blocks splitting and closing already use —
 * so the tree self-repairs exactly as it does for those operations.
 *
 * @example
 * ```txt
 *   ┌─────┬─────┐   drag B onto     ┌───────────┐
 *   │  A  │  B  │   A's top edge →  │     B     │
 *   └─────┴─────┘                   ├───────────┤
 *                                   │     A     │
 *                                   └───────────┘
 * ```
 *
 * Dropping on Center merges the moved pane's views into the target pane
 * instead of splitting (the moved pane's active view stays active).
 *
 * @param layout - The current layout document.
 * @param options - The moved pane, the target pane, and the drop region.
 * @returns The next document, or the same document when the move is not
 * possible (unknown panes, moving onto itself).
 */
function movePane(
  layout: AppShellLayout,
  options: MovePaneOptions,
): AppShellLayout {
  const { workspace } = layout
  const source = findNode(workspace.root, options.paneId)
  const target = findNode(workspace.root, options.targetPaneId)

  if (
    options.paneId === options.targetPaneId ||
    !source ||
    source.type !== "pane" ||
    !target ||
    target.type !== "pane"
  ) {
    return layout
  }

  if (options.region === PaneDropRegion.Center) {
    // Center = merge: the target pane absorbs the moved pane's views and
    // the moved pane closes. (A tab strip renders the combined list later.)
    const mergedViews = [
      ...target.views,
      ...source.views.filter((view) => !target.views.includes(view)),
    ]
    const merged: PaneNode = {
      ...target,
      views: mergedViews,
      ...(source.activeViewId !== undefined
        ? { activeViewId: source.activeViewId }
        : {}),
    }

    const replaceTarget = (node: LayoutNode): LayoutNode => {
      if (node.type === "pane") {
        return node.id === merged.id ? merged : node
      }

      const children = node.children.map(replaceTarget)
      const unchanged = children.every(
        (child, index) => child === node.children[index],
      )

      return unchanged ? node : { ...node, children }
    }

    return focusPane(
      closePane(
        { ...layout, workspace: { ...workspace, root: replaceTarget(workspace.root) } },
        { paneId: options.paneId },
      ),
      { paneId: options.targetPaneId },
    )
  }

  const { root: remaining, removed } = removeNode(workspace.root, options.paneId)

  if (!remaining || !removed) {
    return layout
  }

  // The moved pane's old wrapper split may still exist until normalization,
  // so the new wrapper id is probed for uniqueness like generated pane ids.
  let wrapSplitId = `split:${options.paneId}`

  while (findNode(remaining, wrapSplitId)) {
    wrapSplitId = `${wrapSplitId}+`
  }

  const root = insertRelativeTo(
    remaining,
    options.targetPaneId,
    removed,
    dropRegionToDirection(options.region),
    wrapSplitId,
  )

  return normalizeAppShellLayout({
    ...layout,
    workspace: {
      ...workspace,
      root,
      activePaneId: options.paneId,
      recentPaneIds: promoteRecentPane(workspace.recentPaneIds, options.paneId),
    },
  })
}

/**
 * Swaps two panes: each takes the other's place in the tree while keeping
 * that position's size. Nothing else about the tree changes, so no
 * normalization is needed.
 *
 * @example
 * ```txt
 *   ┌─────┬───┐    swap A and B     ┌─────┬───┐
 *   │  A  │ B │        →            │  B  │ A │
 *   └─────┴───┘                     └─────┴───┘
 *    A ⅔   B ⅓                       B ⅔   A ⅓
 * ```
 *
 * @param layout - The current layout document.
 * @param options - The two panes to swap; the first one keeps focus.
 * @returns The next document, or the same document when either pane is
 * missing or both are the same pane.
 */
function swapPanes(
  layout: AppShellLayout,
  options: { paneId: LayoutNodeId; withPaneId: LayoutNodeId },
): AppShellLayout {
  const { workspace } = layout
  const first = findNode(workspace.root, options.paneId)
  const second = findNode(workspace.root, options.withPaneId)

  if (
    options.paneId === options.withPaneId ||
    !first ||
    first.type !== "pane" ||
    !second ||
    second.type !== "pane"
  ) {
    return layout
  }

  const visit = (node: LayoutNode): LayoutNode => {
    if (node.type === "pane") {
      if (node.id === first.id) return { ...second, weight: node.weight }
      if (node.id === second.id) return { ...first, weight: node.weight }
      return node
    }

    const children = node.children.map(visit)
    const unchanged = children.every(
      (child, index) => child === node.children[index],
    )

    return unchanged ? node : { ...node, children }
  }

  return {
    ...layout,
    workspace: {
      ...workspace,
      root: visit(workspace.root),
      activePaneId: options.paneId,
      recentPaneIds: promoteRecentPane(workspace.recentPaneIds, options.paneId),
    },
  }
}

/**
 * Opens a view in a pane: the view joins the pane's list (if not already
 * there) and becomes its active view.
 *
 * @example
 * ```txt
 * pane views ["chat:a"] + openView "chat:b"
 *   → views ["chat:a", "chat:b"], active "chat:b"
 * ```
 *
 * @param layout - The current layout document.
 * @param options - The view to open and the pane to open it in (defaults
 * to the active pane).
 * @returns The next document with the pane focused, or the same document
 * when the pane is missing.
 */
function openView(
  layout: AppShellLayout,
  options: { viewId: PaneViewId; paneId?: LayoutNodeId },
): AppShellLayout {
  const { workspace } = layout
  const paneId = options.paneId ?? workspace.activePaneId

  const visit = (node: LayoutNode): LayoutNode => {
    if (node.type === "pane") {
      if (node.id !== paneId || node.activeViewId === options.viewId) {
        return node
      }

      return {
        ...node,
        views: node.views.includes(options.viewId)
          ? node.views
          : [...node.views, options.viewId],
        activeViewId: options.viewId,
      }
    }

    const children = node.children.map(visit)
    const unchanged = children.every(
      (child, index) => child === node.children[index],
    )

    return unchanged ? node : { ...node, children }
  }

  const root = visit(workspace.root)

  if (root === workspace.root) {
    // The pane may already show this view — "open" still means "take me
    // there", so it gets focused. A missing pane changes nothing.
    const pane = findNode(workspace.root, paneId)

    return pane && pane.type === "pane" && pane.activeViewId === options.viewId
      ? focusPane(layout, { paneId })
      : layout
  }

  return focusPane(
    { ...layout, workspace: { ...workspace, root } },
    { paneId },
  )
}

/**
 * Focuses a pane, promoting it in the most-recently-active list.
 *
 * @param layout - The current layout document.
 * @param options - The pane to focus.
 * @returns The next document, or the same document when the pane is absent
 * or already active.
 */
function focusPane(
  layout: AppShellLayout,
  options: { paneId: LayoutNodeId },
): AppShellLayout {
  const { workspace } = layout

  if (workspace.activePaneId === options.paneId) {
    return layout
  }

  const target = findNode(workspace.root, options.paneId)

  if (!target || target.type !== "pane") {
    return layout
  }

  return {
    ...layout,
    workspace: {
      ...workspace,
      activePaneId: options.paneId,
      recentPaneIds: promoteRecentPane(workspace.recentPaneIds, options.paneId),
    },
  }
}

/**
 * Maximizes a pane over the workspace without restructuring the tree.
 *
 * @param layout - The current layout document.
 * @param options - The pane to maximize. Defaults to the active pane.
 * @returns The next document, or the same document when the pane is absent.
 */
function maximizePane(
  layout: AppShellLayout,
  options: { paneId?: LayoutNodeId } = {},
): AppShellLayout {
  const { workspace } = layout
  const paneId = options.paneId ?? workspace.activePaneId
  const target = findNode(workspace.root, paneId)

  if (!target || target.type !== "pane") {
    return layout
  }

  return focusPane(
    { ...layout, workspace: { ...workspace, maximizedPaneId: paneId } },
    { paneId },
  )
}

/**
 * Restores a maximized workspace to its split presentation.
 *
 * @param layout - The current layout document.
 * @returns The next document, or the same document when nothing is maximized.
 */
function restorePane(layout: AppShellLayout): AppShellLayout {
  if (layout.workspace.maximizedPaneId === undefined) {
    return layout
  }

  const { maximizedPaneId: _restored, ...workspace } = layout.workspace

  return { ...layout, workspace }
}

/**
 * Replaces the sibling sizes of one split, then repairs the document. The
 * weights can be in any scale — they are rescaled to sum to 1:
 *
 * @example
 * ```txt
 * weights [3, 1] → children sized [0.75, 0.25]
 * ```
 *
 * @param layout - The current layout document.
 * @param options - The split id and one weight per child, in child order.
 * @returns The next document, or the same document when the split is absent
 * or the weight count does not match its children.
 */
function setSplitWeights(
  layout: AppShellLayout,
  options: { splitId: LayoutNodeId; weights: readonly number[] },
): AppShellLayout {
  const { workspace } = layout

  /**
   * Rebuilds one subtree with the new weights applied.
   *
   * @param current - The subtree root being visited.
   * @returns The rebuilt subtree, or the same reference when untouched.
   */
  const visit = (current: LayoutNode): LayoutNode => {
    if (current.type === "pane") {
      return current
    }

    if (current.id === options.splitId) {
      if (options.weights.length !== current.children.length) {
        return current
      }

      return {
        ...current,
        children: current.children.map((child, index) => ({
          ...child,
          weight: options.weights[index],
        })),
      }
    }

    const children = current.children.map(visit)
    const unchanged = children.every(
      (child, index) => child === current.children[index],
    )

    return unchanged ? current : { ...current, children }
  }

  const root = visit(workspace.root)

  if (root === workspace.root) {
    return layout
  }

  return normalizeAppShellLayout({
    ...layout,
    workspace: { ...workspace, root },
  })
}

/**
 * Resets every split in the workspace to evenly distributed weights.
 *
 * @param layout - The current layout document.
 * @returns The normalized next document.
 */
function resetPaneSizes(layout: AppShellLayout): AppShellLayout {
  /**
   * Rebuilds one subtree with even weights.
   *
   * @param current - The subtree root being visited.
   * @returns The rebuilt subtree.
   */
  const visit = (current: LayoutNode): LayoutNode => {
    if (current.type === "pane") {
      return current
    }

    return {
      ...current,
      children: current.children.map((child) => ({
        ...visit(child),
        weight: formatWeight(1 / current.children.length),
      })),
    }
  }

  return normalizeAppShellLayout({
    ...layout,
    workspace: { ...layout.workspace, root: visit(layout.workspace.root) },
  })
}

/**
 * Opens or closes one dock. The dock's size is retained while closed.
 *
 * @param layout - The current layout document.
 * @param options - The dock side and requested visibility.
 * @returns The next document, or the same document when nothing changes.
 */
function setDockOpen(
  layout: AppShellLayout,
  options: { side: AppShellDockSide; open: boolean },
): AppShellLayout {
  const dock = layout.docks[options.side]

  if (dock.open === options.open) {
    return layout
  }

  return {
    ...layout,
    docks: { ...layout.docks, [options.side]: { ...dock, open: options.open } },
  }
}

/**
 * Reverses one dock's visibility.
 *
 * @param layout - The current layout document.
 * @param options - The dock side to toggle.
 * @returns The next document.
 */
function toggleDock(
  layout: AppShellLayout,
  options: { side: AppShellDockSide },
): AppShellLayout {
  return setDockOpen(layout, {
    side: options.side,
    open: !layout.docks[options.side].open,
  })
}

/**
 * Resizes one dock in pixels, clamped to optional bounds.
 *
 * @param layout - The current layout document.
 * @param options - The dock side, requested size, and optional bounds.
 * @returns The next document, or the same document when nothing changes.
 */
function resizeDock(
  layout: AppShellLayout,
  options: {
    side: AppShellDockSide
    size: number
    minSize?: number
    maxSize?: number
  },
): AppShellLayout {
  const dock = layout.docks[options.side]
  const size = Math.round(
    Math.min(
      options.maxSize ?? Number.MAX_SAFE_INTEGER,
      Math.max(options.minSize ?? 0, options.size),
    ),
  )

  if (!Number.isFinite(size) || dock.size === size) {
    return layout
  }

  return {
    ...layout,
    docks: { ...layout.docks, [options.side]: { ...dock, size } },
  }
}

export {
  closePane,
  createAppShellLayout,
  createPaneNode,
  focusPane,
  insertRelativeTo,
  maximizePane,
  movePane,
  openView,
  promoteRecentPane,
  removeNode,
  resetPaneSizes,
  resizeDock,
  restorePane,
  setDockOpen,
  setSplitWeights,
  splitPane,
  swapPanes,
  toggleDock,
  type CreateAppShellLayoutOptions,
  type CreatePaneOptions,
  type MovePaneOptions,
  type SplitPaneOptions,
}
