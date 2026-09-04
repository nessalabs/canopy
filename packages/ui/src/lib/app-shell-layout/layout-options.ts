const SplitOrientation = Object.freeze({
  Horizontal: "horizontal",
  Vertical: "vertical",
} as const)

/** A supported axis for a split node's children. */
type SplitOrientation = (typeof SplitOrientation)[keyof typeof SplitOrientation]

/** Directions in which an existing pane can be split. */
const PaneSplitDirection = Object.freeze({
  Up: "up",
  Down: "down",
  Left: "left",
  Right: "right",
} as const)

/** A supported direction for splitting an existing pane. */
type PaneSplitDirection =
  (typeof PaneSplitDirection)[keyof typeof PaneSplitDirection]

/**
 * Regions of a pane that can accept a dropped pane or view. Reserved
 * vocabulary for the drag-and-drop layer; unused by resize-only layouts.
 */
const PaneDropRegion = Object.freeze({
  Center: "center",
  Top: "top",
  Right: "right",
  Bottom: "bottom",
  Left: "left",
} as const)

/** A supported drop region within a pane. */
type PaneDropRegion = (typeof PaneDropRegion)[keyof typeof PaneDropRegion]

/** Fixed dock slots surrounding the recursive workspace. */
const AppShellDockSide = Object.freeze({
  Left: "left",
  Right: "right",
  Bottom: "bottom",
} as const)

/** A supported dock slot around the workspace. */
type AppShellDockSide = (typeof AppShellDockSide)[keyof typeof AppShellDockSide]

/**
 * Resolves the split orientation produced by splitting along a direction.
 *
 * @param direction - The requested split direction.
 * @returns The orientation of the split node that hosts the two panes.
 */
function splitDirectionToOrientation(
  direction: PaneSplitDirection,
): SplitOrientation {
  return direction === PaneSplitDirection.Left ||
    direction === PaneSplitDirection.Right
    ? SplitOrientation.Horizontal
    : SplitOrientation.Vertical
}

/**
 * Determines whether a split direction inserts after the reference pane.
 *
 * @param direction - The requested split direction.
 * @returns Whether the new pane lands after (right of / below) the reference.
 */
function splitDirectionIsAfter(direction: PaneSplitDirection): boolean {
  return (
    direction === PaneSplitDirection.Right ||
    direction === PaneSplitDirection.Down
  )
}

export {
  AppShellDockSide,
  PaneDropRegion,
  PaneSplitDirection,
  SplitOrientation,
  splitDirectionIsAfter,
  splitDirectionToOrientation,
}
