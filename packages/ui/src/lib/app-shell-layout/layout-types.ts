import type { AppShellDockSide, SplitOrientation } from "./layout-options"

/** Current schema version written by `createAppShellLayout`. */
const APP_SHELL_LAYOUT_VERSION = 1

/**
 * Stable, opaque identity for one layout node. Never derived from position;
 * ids survive splits, closes, and future drag-and-drop moves. The consuming
 * application is responsible for keeping ids unique within one document.
 */
type LayoutNodeId = string

/**
 * Stable key the consuming application resolves to renderable pane content.
 * The layout model never stores React elements; it stores these keys only.
 */
type PaneViewId = string

/** A leaf of the workspace tree hosting an ordered list of views. */
interface PaneNode {
  readonly type: "pane"
  readonly id: LayoutNodeId
  /**
   * Share of the parent split's main axis. Siblings sum to 1 after
   * normalization. Unitless and display-independent; ignored on the root.
   */
  readonly weight: number
  /**
   * Ordered views hosted by this pane. Resize-only layouts render the active
   * view; a future tab strip renders the full list without a schema change.
   */
  readonly views: readonly PaneViewId[]
  /** The view currently presented by this pane. */
  readonly activeViewId?: PaneViewId
}

/** An n-ary interior node laying out children along one explicit axis. */
interface SplitNode {
  readonly type: "split"
  readonly id: LayoutNodeId
  /**
   * Share of the parent split's main axis. Siblings sum to 1 after
   * normalization. Unitless and display-independent; ignored on the root.
   */
  readonly weight: number
  /** The axis along which children are laid out. Never inferred from depth. */
  readonly orientation: SplitOrientation
  /** Ordered children. Normalized splits always hold two or more. */
  readonly children: readonly LayoutNode[]
}

/** Any node of the recursive workspace tree. */
type LayoutNode = PaneNode | SplitNode

/** The recursive center region of the shell plus its out-of-tree pointers. */
interface WorkspaceLayout {
  /** The tree root. A lone pane is a legal root for single-pane layouts. */
  readonly root: LayoutNode
  /** The pane that owns focus-routed commands. References an existing pane. */
  readonly activePaneId: LayoutNodeId
  /**
   * Most-recently-active pane ids, most recent first. Determines where focus
   * lands after the active pane closes.
   */
  readonly recentPaneIds: readonly LayoutNodeId[]
  /**
   * A pane temporarily presented over the whole workspace. Rendering-only;
   * maximizing never restructures the tree.
   */
  readonly maximizedPaneId?: LayoutNodeId
}

/** Visibility and extent of one fixed dock slot. */
interface AppShellDockState {
  /** Whether the dock is currently presented. */
  readonly open: boolean
  /**
   * Extent along the dock's resize axis in CSS pixels. Retained while the
   * dock is closed so reopening restores the previous extent.
   */
  readonly size: number
}

/** The complete serializable layout document for one AppShell. */
interface AppShellLayout {
  /** Schema version. Consumers migrate or discard on mismatch. */
  readonly version: typeof APP_SHELL_LAYOUT_VERSION
  /** Fixed, pixel-sized dock slots outside the recursive tree. */
  readonly docks: Readonly<Record<AppShellDockSide, AppShellDockState>>
  /** The recursive, weight-sized workspace. */
  readonly workspace: WorkspaceLayout
}

export {
  APP_SHELL_LAYOUT_VERSION,
  type AppShellDockState,
  type AppShellLayout,
  type LayoutNode,
  type LayoutNodeId,
  type PaneNode,
  type PaneViewId,
  type SplitNode,
  type WorkspaceLayout,
}
