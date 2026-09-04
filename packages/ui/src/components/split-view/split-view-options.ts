const SplitViewOrientation = Object.freeze({
  Horizontal: "horizontal",
  Vertical: "vertical",
} as const)

/** A supported axis for SplitView panels. */
type SplitViewOrientation =
  (typeof SplitViewOrientation)[keyof typeof SplitViewOrientation]

export { SplitViewOrientation }
