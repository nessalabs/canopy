import type {
  AppShellDockState,
  AppShellLayout,
  LayoutNode,
  LayoutNodeId,
  PaneNode,
  SplitNode,
  WorkspaceLayout,
} from "./layout-types"

/** Tolerance used when checking that sibling weights already sum to one. */
const WEIGHT_SUM_TOLERANCE = 0.000001

/**
 * Rounds a weight to a stable precision so repeated normalization does not
 * accumulate floating-point drift.
 *
 * @param weight - The raw weight value.
 * @returns The weight rounded to six decimal places.
 */
function formatWeight(weight: number): number {
  return parseFloat(weight.toFixed(6))
}

/**
 * Rescales sibling weights so they always add up to exactly 1.
 *
 * A weight of 0 is allowed — that is simply a fully collapsed pane. Only
 * broken input (negative numbers, NaN, or a total of 0) is replaced with an
 * even share for everyone.
 *
 * @example
 * ```txt
 * [2, 1, 1]      → [0.5, 0.25, 0.25]   scaled so the total is 1
 * [0, 0.4, 0.6]  → [0, 0.4, 0.6]       already fine, zero stays
 * [-2, NaN]      → [0.5, 0.5]          broken input → even split
 * ```
 *
 * @param weights - The proposed sibling weights.
 * @returns Sibling weights that are non-negative and sum to one.
 */
function normalizeWeights(weights: readonly number[]): number[] {
  const invalid = weights.some(
    (weight) => !Number.isFinite(weight) || weight < 0,
  )
  const total = weights.reduce((sum, weight) => sum + weight, 0)

  if (invalid || total <= 0) {
    return weights.map(() => formatWeight(1 / weights.length))
  }

  if (Math.abs(total - 1) <= WEIGHT_SUM_TOLERANCE) {
    return [...weights]
  }

  return weights.map((weight) => formatWeight(weight / total))
}

/**
 * Cleans up one subtree, working from the leaves upward. Two shapes get
 * repaired, and neither repair changes what the user sees on screen:
 *
 * 1. A split nested inside another split that points the same way is
 *    merged into its parent (the child weights are scaled so sizes stay
 *    identical):
 *
 * ```txt
 *    before                         after
 *    H ─────────────────            H ─────────────────
 *    ├─ pane A (0.5)               ├─ pane A (0.5)
 *    └─ H (0.5)              →     ├─ pane B (0.25)
 *       ├─ pane B (0.5)            └─ pane C (0.25)
 *       └─ pane C (0.5)
 * ```
 *
 * 2. A split left with a single child disappears — the child takes its
 *    place (and its weight):
 *
 * ```txt
 *    H ─────────────────
 *    ├─ pane A (0.5)               H ─────────────────
 *    └─ V (0.5)              →     ├─ pane A (0.5)
 *       └─ pane B (1)              └─ pane B (0.5)
 * ```
 *
 * Sibling weights are rescaled at each level so they sum to 1.
 *
 * @param node - The subtree root to normalize.
 * @returns The normalized subtree, or null when the subtree holds no panes.
 */
function normalizeNode(node: LayoutNode): LayoutNode | null {
  if (node.type === "pane") {
    return node
  }

  const children: LayoutNode[] = []

  for (const child of node.children) {
    const normalized = normalizeNode(child)

    if (!normalized) continue

    if (
      normalized.type === "split" &&
      normalized.orientation === node.orientation
    ) {
      // A split inside a split pointing the same way looks exactly like one
      // flat row of siblings, so we lift its children up a level. Scaling
      // each lifted weight by the old wrapper's weight keeps every pane at
      // the same on-screen size.
      for (const grandchild of normalized.children) {
        children.push({
          ...grandchild,
          weight: formatWeight(grandchild.weight * normalized.weight),
        })
      }
    } else {
      children.push(normalized)
    }
  }

  if (children.length === 0) {
    return null
  }

  if (children.length === 1) {
    const child = children[0]
    return child.weight === node.weight
      ? child
      : { ...child, weight: node.weight }
  }

  const weights = normalizeWeights(children.map((child) => child.weight))
  const normalizedChildren = children.map((child, index) =>
    child.weight === weights[index]
      ? child
      : { ...child, weight: weights[index] },
  )

  const unchanged =
    normalizedChildren.length === node.children.length &&
    normalizedChildren.every((child, index) => child === node.children[index])

  return unchanged ? node : { ...node, children: normalizedChildren }
}

/**
 * Collects every pane in traversal order.
 *
 * @param node - The subtree root to walk.
 * @returns All pane nodes in depth-first, start-to-end order.
 */
function collectPanes(node: LayoutNode): PaneNode[] {
  if (node.type === "pane") {
    return [node]
  }

  return node.children.flatMap(collectPanes)
}

/**
 * Finds a node by id.
 *
 * @param node - The subtree root to search.
 * @param id - The node id to find.
 * @returns The matching node, or undefined when absent.
 */
function findNode(node: LayoutNode, id: LayoutNodeId): LayoutNode | undefined {
  if (node.id === id) {
    return node
  }

  if (node.type === "split") {
    for (const child of node.children) {
      const match = findNode(child, id)
      if (match) return match
    }
  }

  return undefined
}

/**
 * Repairs a whole workspace: cleans the tree (see `normalizeNode`) and then
 * fixes the three bookkeeping pointers so none of them names a pane that no
 * longer exists — the active pane falls back to the most recently used
 * surviving pane, the recently-used list drops dead ids and duplicates, and
 * a stale maximize pointer is cleared.
 *
 * @param workspace - The workspace layout to normalize.
 * @returns An equivalent workspace with every rule restored.
 */
function normalizeWorkspaceLayout(workspace: WorkspaceLayout): WorkspaceLayout {
  // A document with no panes at all (for example an empty split from a bad
  // save) cannot render or accept operations, so it becomes one empty pane.
  const root: LayoutNode = normalizeNode(workspace.root) ?? {
    type: "pane",
    id: workspace.activePaneId || "pane-1",
    weight: 1,
    views: [],
  }
  const panes = collectPanes(root)
  const paneIds = new Set(panes.map((pane) => pane.id))

  const recentPaneIds = workspace.recentPaneIds.filter(
    (id, index, ids) => paneIds.has(id) && ids.indexOf(id) === index,
  )

  const activePaneId = paneIds.has(workspace.activePaneId)
    ? workspace.activePaneId
    : (recentPaneIds[0] ?? panes[0]?.id ?? workspace.activePaneId)

  if (paneIds.has(activePaneId) && activePaneId !== recentPaneIds[0]) {
    const remaining = recentPaneIds.filter((id) => id !== activePaneId)
    recentPaneIds.length = 0
    recentPaneIds.push(activePaneId, ...remaining)
  }

  const maximizedPaneId =
    workspace.maximizedPaneId !== undefined &&
    paneIds.has(workspace.maximizedPaneId)
      ? workspace.maximizedPaneId
      : undefined

  const unchanged =
    root === workspace.root &&
    activePaneId === workspace.activePaneId &&
    maximizedPaneId === workspace.maximizedPaneId &&
    recentPaneIds.length === workspace.recentPaneIds.length &&
    recentPaneIds.every((id, index) => id === workspace.recentPaneIds[index])

  if (unchanged) {
    return workspace
  }

  return {
    root,
    activePaneId,
    recentPaneIds,
    ...(maximizedPaneId !== undefined ? { maximizedPaneId } : {}),
  }
}

/**
 * Repairs one dock entry: `open` becomes a real boolean and `size` becomes
 * a whole, non-negative number of pixels (broken sizes fall back to 0; the
 * dock component clamps to its real minimum when rendering).
 *
 * @param dock - The dock state to repair.
 * @returns The repaired dock state, or the same object when already clean.
 */
function normalizeDockState(dock: AppShellDockState): AppShellDockState {
  const open = dock.open === true
  const size =
    Number.isFinite(dock.size) && dock.size >= 0 ? Math.round(dock.size) : 0

  return open === dock.open && size === dock.size ? dock : { open, size }
}

/**
 * Repairs a complete layout document — the workspace tree, its pointers,
 * and the dock entries. Safe to call as often as needed: running it on an
 * already clean document returns the very same object.
 *
 * @param layout - The layout document to normalize.
 * @returns An equivalent document with every rule restored.
 */
function normalizeAppShellLayout(layout: AppShellLayout): AppShellLayout {
  const workspace = normalizeWorkspaceLayout(layout.workspace)

  let docks = layout.docks

  for (const [side, dock] of Object.entries(layout.docks)) {
    const normalized = normalizeDockState(dock)

    if (normalized !== dock) {
      docks = { ...docks, [side]: normalized }
    }
  }

  return workspace === layout.workspace && docks === layout.docks
    ? layout
    : { ...layout, workspace, docks }
}

export {
  collectPanes,
  findNode,
  formatWeight,
  normalizeAppShellLayout,
  normalizeWeights,
  normalizeWorkspaceLayout,
}
