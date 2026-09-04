type SplitViewLayout = Record<string, number>

/** Percentage-resolved sizing constraints for one panel. */
interface SplitViewPanelConstraints {
  /** The panel these constraints belong to. */
  panelId: string
  /** Smallest expanded size, as a percentage of the group. */
  minSize: number
  /** Largest size, as a percentage of the group. */
  maxSize: number
  /** Size presented while collapsed, as a percentage of the group. */
  collapsedSize: number
  /** Whether the panel snaps closed below its minimum size. */
  collapsible: boolean
  /** Preferred initial size, as a percentage of the group. */
  defaultSize?: number
}

/** The interaction that produced a layout adjustment. */
type SplitViewResizeTrigger = "pointer" | "keyboard"

/**
 * Sizes a panel may declare: numbers are percentages of the group, strings
 * accept pixel ("240px") or percentage ("25%") units.
 */
type SplitViewSize = number | `${number}px` | `${number}%`

/**
 * Throws when a layout invariant does not hold.
 *
 * @param condition - The invariant expected to be truthy.
 * @param message - The failure description.
 */
function assertLayout(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

/**
 * Rounds a percentage to the stable precision used by every layout
 * comparison, preventing floating-point drift across adjustments.
 *
 * @param value - The raw percentage.
 * @returns The percentage rounded to three decimal places.
 */
function formatLayoutNumber(value: number): number {
  return parseFloat(value.toFixed(3))
}

/**
 * Compares two percentages at layout precision.
 *
 * @param actual - The first percentage.
 * @param expected - The second percentage.
 * @param tolerance - Extra tolerance beyond layout precision.
 * @returns Whether the percentages are equal at layout precision.
 */
function layoutNumbersEqual(
  actual: number,
  expected: number,
  tolerance = 0,
): boolean {
  return (
    Math.abs(formatLayoutNumber(actual) - formatLayoutNumber(expected)) <=
    tolerance
  )
}

/**
 * Orders two percentages at layout precision.
 *
 * @param actual - The first percentage.
 * @param expected - The second percentage.
 * @returns Zero when equal at layout precision, otherwise the sign of the
 * difference.
 */
function compareLayoutNumbers(actual: number, expected: number): number {
  if (layoutNumbersEqual(actual, expected)) {
    return 0
  }

  return actual > expected ? 1 : -1
}

/**
 * Compares two layouts for equality at layout precision.
 *
 * @param a - The first layout.
 * @param b - The second layout.
 * @returns Whether both layouts hold the same panels at the same sizes.
 */
function splitViewLayoutsEqual(a: SplitViewLayout, b: SplitViewLayout): boolean {
  const aKeys = Object.keys(a)

  if (aKeys.length !== Object.keys(b).length) {
    return false
  }

  return aKeys.every(
    (id) => b[id] !== undefined && compareLayoutNumbers(a[id], b[id]) === 0,
  )
}

/**
 * Takes a proposed size for one panel and returns the nearest size the
 * panel's rules allow (never below min, never above max).
 *
 * A collapsible panel has a dead zone between its collapsed size and its
 * minimum size — a size landing there snaps to whichever edge is closer:
 *
 * ```txt
 *  collapsed          min                         max
 *    5%               20%                         100%
 *     ├───────┬────────┼───────── allowed ─────────┤
 *     │ snaps │ snaps  │
 *     │ shut  │ open   │
 *          12.5% = halfway point
 * ```
 *
 * @param options - The proposed size and the owning panel's constraints.
 * @returns The nearest size the panel's constraints allow.
 */
function validatePanelSize(options: {
  constraints: SplitViewPanelConstraints
  size: number
}): number {
  const { collapsedSize, collapsible, maxSize, minSize } = options.constraints
  let size = options.size

  if (compareLayoutNumbers(size, minSize) < 0) {
    if (collapsible) {
      const halfwayPoint = (collapsedSize + minSize) / 2
      size = compareLayoutNumbers(size, halfwayPoint) < 0 ? collapsedSize : minSize
    } else {
      size = minSize
    }
  }

  return formatLayoutNumber(Math.min(maxSize, size))
}

/**
 * Repairs a proposed layout so every panel respects its size rules and the
 * total is exactly 100. Every layout passes through here before it is
 * rendered.
 *
 * @example
 * ```txt
 * { a: 30, b: 30 }                 → { a: 50, b: 50 }   rescaled to 100
 * { a: 90, b: 10 }, a max 60       → { a: 60, b: 40 }   overflow moved to b
 * { a: 0, b: 0 }                   → { a: 50, b: 50 }   garbage → even split
 * ```
 *
 * If the rules themselves are impossible (for example two panels that both
 * demand a 60% minimum), the result is best-effort: every panel gets as
 * close to its rules as possible, and the total may not reach exactly 100.
 * Rendering stays sensible because panel sizes are relative to each other.
 *
 * @param options - The proposed layout and per-panel constraints, in order.
 * @returns A valid layout as close to the proposal as the rules allow.
 * @throws When the layout and constraints describe different panel counts.
 */
function validatePanelGroupLayout(options: {
  layout: SplitViewLayout
  panelConstraints: readonly SplitViewPanelConstraints[]
}): SplitViewLayout {
  const { layout, panelConstraints } = options
  const prevLayout = Object.values(layout)
  const nextLayout = [...prevLayout]

  const totalSize = nextLayout.reduce((total, size) => total + size, 0)

  if (nextLayout.length !== panelConstraints.length) {
    throw new Error(
      `Invalid ${panelConstraints.length} panel layout: ${nextLayout
        .map((size) => `${size}%`)
        .join(", ")}`,
    )
  }

  if (nextLayout.length > 0 && (!Number.isFinite(totalSize) || totalSize <= 0)) {
    // All zeros or broken numbers cannot be rescaled (100 ÷ 0), so start
    // over from an even split and let the rules below shape it.
    for (let index = 0; index < panelConstraints.length; index++) {
      nextLayout[index] = 100 / nextLayout.length
    }
  } else if (!layoutNumbersEqual(totalSize, 100) && nextLayout.length > 0) {
    for (let index = 0; index < panelConstraints.length; index++) {
      nextLayout[index] = (100 / totalSize) * nextLayout[index]
    }
  }

  let remainingSize = 0

  for (let index = 0; index < panelConstraints.length; index++) {
    const unsafeSize = nextLayout[index]
    const safeSize = validatePanelSize({
      constraints: panelConstraints[index],
      size: unsafeSize,
    })

    if (unsafeSize !== safeSize) {
      remainingSize += unsafeSize - safeSize
      nextLayout[index] = safeSize
    }
  }

  if (!layoutNumbersEqual(remainingSize, 0)) {
    for (let index = 0; index < panelConstraints.length; index++) {
      const prevSize = nextLayout[index]
      const unsafeSize = prevSize + remainingSize
      const safeSize = validatePanelSize({
        constraints: panelConstraints[index],
        size: unsafeSize,
      })

      if (prevSize !== safeSize) {
        remainingSize -= safeSize - prevSize
        nextLayout[index] = safeSize

        if (layoutNumbersEqual(remainingSize, 0)) {
          break
        }
      }
    }
  }

  const keys = Object.keys(layout)

  return nextLayout.reduce<SplitViewLayout>((accumulated, size, index) => {
    accumulated[keys[index]] = size
    return accumulated
  }, {})
}

/**
 * The heart of resizing: moves a separator by `delta` percent and works out
 * the new size of every panel.
 *
 * The simple case — drag the separator between A and B by +10:
 *
 * ```txt
 *   before   │  A 50%  ┃  B 50%  │        ┃ = the separator
 *   after    │   A 60%   ┃ B 40% │
 * ```
 *
 * When the nearest neighbor cannot shrink any further, the leftover pull
 * spills over to the next panel on that side, and so on down the row:
 *
 * ```txt
 *   before   │ A 40% ┃ B 30% │ C 30% │    B and C both have min 20%
 *   drag +25 │    A 60%   ┃ B 20% │ C 20% │
 *              A only gained 20 — that is all B and C could give.
 * ```
 *
 * Two details matter for how dragging feels:
 *
 * - The distance is always measured from where the pointer went DOWN
 *   (`initialLayout`), not from the previous mouse event. Dragging past a
 *   limit and back never leaves the panels drifted from the pointer.
 * - A collapsible panel only snaps open/shut once the drag crosses the
 *   halfway point (see `validatePanelSize`). Keyboard steps skip that
 *   halfway rule, otherwise a small arrow-key step could never open a
 *   collapsed panel.
 *
 * @param options - The delta, starting and current layouts, ordered panel
 * constraints, the separator's neighboring panel indices, and the trigger.
 * @returns The adjusted layout, or the current layout when the delta cannot
 * be applied.
 */
function adjustLayoutByDelta(options: {
  delta: number
  initialLayout: SplitViewLayout
  panelConstraints: readonly SplitViewPanelConstraints[]
  pivotIndices: readonly [number, number]
  prevLayout: SplitViewLayout
  trigger: SplitViewResizeTrigger
}): SplitViewLayout {
  const { initialLayout: initialLayoutProp, panelConstraints, pivotIndices, prevLayout: prevLayoutProp, trigger } = options
  let { delta } = options

  if (layoutNumbersEqual(delta, 0)) {
    return initialLayoutProp
  }

  const initialLayout = Object.values(initialLayoutProp)
  const prevLayout = Object.values(prevLayoutProp)
  const nextLayout = [...initialLayout]

  const [firstPivotIndex, secondPivotIndex] = pivotIndices
  assertLayout(
    panelConstraints[firstPivotIndex] && panelConstraints[secondPivotIndex],
    "Invalid pivot indices",
  )

  let deltaApplied = 0

  if (trigger === "keyboard") {
    {
      // A collapsed panel expands to its minimum size when the keyboard step
      // is smaller than the gap; the halfway threshold is skipped so the
      // panel can always expand.
      const index = delta < 0 ? secondPivotIndex : firstPivotIndex
      const constraints = panelConstraints[index]

      if (constraints.collapsible) {
        const prevSize = initialLayout[index]

        if (layoutNumbersEqual(prevSize, constraints.collapsedSize)) {
          const localDelta = constraints.minSize - prevSize

          if (compareLayoutNumbers(localDelta, Math.abs(delta)) > 0) {
            delta = delta < 0 ? 0 - localDelta : localDelta
          }
        }
      }
    }

    {
      // A panel resting at its minimum size collapses outright when the
      // keyboard step is smaller than the gap.
      const index = delta < 0 ? firstPivotIndex : secondPivotIndex
      const constraints = panelConstraints[index]

      if (constraints.collapsible) {
        const prevSize = initialLayout[index]

        if (layoutNumbersEqual(prevSize, constraints.minSize)) {
          const localDelta = prevSize - constraints.collapsedSize

          if (compareLayoutNumbers(localDelta, Math.abs(delta)) > 0) {
            delta = delta < 0 ? 0 - localDelta : localDelta
          }
        }
      }
    }
  } else {
    // Dragging away from a collapsed panel does nothing until the pointer
    // crosses the halfway point, then the panel snaps open to its minimum.
    const index = delta < 0 ? secondPivotIndex : firstPivotIndex
    const constraints = panelConstraints[index]
    const prevSize = initialLayout[index]

    if (
      constraints.collapsible &&
      compareLayoutNumbers(prevSize, constraints.minSize) < 0
    ) {
      const gapSize = constraints.minSize - constraints.collapsedSize

      if (delta > 0) {
        const halfwayDelta = gapSize / 2
        const nextSize = prevSize + delta

        if (compareLayoutNumbers(nextSize, constraints.minSize) < 0) {
          delta = compareLayoutNumbers(delta, halfwayDelta) <= 0 ? 0 : gapSize
        }
      } else {
        const halfwayDelta = 100 - gapSize / 2
        const nextSize = prevSize - delta

        if (compareLayoutNumbers(nextSize, constraints.minSize) < 0) {
          delta =
            compareLayoutNumbers(100 + delta, halfwayDelta) > 0 ? 0 : -gapSize
        }
      }
    }
  }

  {
    // Clamp the requested delta to the headroom available on the growing
    // side; an expanding panel cannot take more than its neighbors can give.
    const increment = delta < 0 ? 1 : -1

    let index = delta < 0 ? secondPivotIndex : firstPivotIndex
    let maxAvailableDelta = 0

    while (true) {
      const prevSize = initialLayout[index]
      const maxSafeSize = validatePanelSize({
        constraints: panelConstraints[index],
        size: 100,
      })

      maxAvailableDelta += maxSafeSize - prevSize
      index += increment

      if (index < 0 || index >= panelConstraints.length) {
        break
      }
    }

    const minAbsDelta = Math.min(Math.abs(delta), Math.abs(maxAvailableDelta))
    delta = delta < 0 ? 0 - minAbsDelta : minAbsDelta
  }

  {
    // Cascade the shrink outward from the pivot, taking from the nearest
    // panels first until the full delta is absorbed.
    const pivotIndex = delta < 0 ? firstPivotIndex : secondPivotIndex
    let index = pivotIndex

    while (index >= 0 && index < panelConstraints.length) {
      const deltaRemaining = Math.abs(delta) - Math.abs(deltaApplied)

      const prevSize = initialLayout[index]
      const unsafeSize = prevSize - deltaRemaining
      const safeSize = validatePanelSize({
        constraints: panelConstraints[index],
        size: unsafeSize,
      })

      if (!layoutNumbersEqual(prevSize, safeSize)) {
        deltaApplied += prevSize - safeSize
        nextLayout[index] = safeSize

        if (
          deltaApplied
            .toFixed(3)
            .localeCompare(Math.abs(delta).toFixed(3), undefined, {
              numeric: true,
            }) >= 0
        ) {
          break
        }
      }

      if (delta < 0) {
        index--
      } else {
        index++
      }
    }
  }

  // Nothing could shrink, so the interaction is ignored — for example a drag
  // continuing past a boundary that is already at its limit.
  if (
    prevLayout.length === nextLayout.length &&
    prevLayout.every((size, index) => size === nextLayout[index])
  ) {
    return prevLayoutProp
  }

  {
    // Grant the growing side only what the shrinking side could release, and
    // re-cascade when growth flips another panel's collapsed state.
    const pivotIndex = delta < 0 ? secondPivotIndex : firstPivotIndex

    const prevSize = initialLayout[pivotIndex]
    const unsafeSize = prevSize + deltaApplied
    const safeSize = validatePanelSize({
      constraints: panelConstraints[pivotIndex],
      size: unsafeSize,
    })

    nextLayout[pivotIndex] = safeSize

    if (!layoutNumbersEqual(safeSize, unsafeSize)) {
      let deltaRemaining = unsafeSize - safeSize
      let index = pivotIndex

      while (index >= 0 && index < panelConstraints.length) {
        const currentSize = nextLayout[index]
        const nextUnsafeSize = currentSize + deltaRemaining
        const nextSafeSize = validatePanelSize({
          constraints: panelConstraints[index],
          size: nextUnsafeSize,
        })

        if (!layoutNumbersEqual(currentSize, nextSafeSize)) {
          deltaRemaining -= nextSafeSize - currentSize
          nextLayout[index] = nextSafeSize
        }

        if (layoutNumbersEqual(deltaRemaining, 0)) {
          break
        }

        if (delta > 0) {
          index--
        } else {
          index++
        }
      }
    }
  }

  const totalSize = nextLayout.reduce((total, size) => total + size, 0)

  // A layout that no longer totals 100 means the delta cannot be applied;
  // fall back to the most recent valid layout.
  if (!layoutNumbersEqual(totalSize, 100, 0.1)) {
    return prevLayoutProp
  }

  const keys = Object.keys(prevLayoutProp)

  return nextLayout.reduce<SplitViewLayout>((accumulated, size, index) => {
    accumulated[keys[index]] = size
    return accumulated
  }, {})
}

/**
 * Builds the starting layout for a group: panels that asked for a size get
 * it, and the leftover space is shared evenly by everyone else.
 *
 * @example
 * ```txt
 * a wants 30, b and c don't say  →  { a: 30, b: 35, c: 35 }
 * ```
 *
 * @param panelConstraints - The ordered per-panel constraints.
 * @returns A layout honoring requested sizes and totaling 100.
 */
function calculateDefaultLayout(
  panelConstraints: readonly SplitViewPanelConstraints[],
): SplitViewLayout {
  let explicitCount = 0
  let total = 0

  const layout: SplitViewLayout = {}

  for (const constraints of panelConstraints) {
    if (constraints.defaultSize !== undefined) {
      explicitCount++

      const size = formatLayoutNumber(constraints.defaultSize)

      total += size
      layout[constraints.panelId] = size
    } else {
      layout[constraints.panelId] = 0
    }
  }

  const remainingCount = panelConstraints.length - explicitCount

  if (remainingCount !== 0) {
    const size = formatLayoutNumber((100 - total) / remainingCount)

    for (const constraints of panelConstraints) {
      if (constraints.defaultSize === undefined) {
        layout[constraints.panelId] = size
      }
    }
  }

  return layout
}

/**
 * Works out what a separator should tell screen readers: the panel's
 * current size plus the smallest and largest sizes it can actually reach.
 *
 * "Actually reach" is the point: a panel may claim max 100%, but if its
 * neighbor refuses to shrink below 20%, the real ceiling is 80%. Instead of
 * trusting the declared limits, this runs the resize math in both
 * directions and reports where it truly lands:
 *
 * ```txt
 * { a: 50, b: 50 }, b has min 20  →  a: now 50, min 0, max 80
 * ```
 *
 * @param options - The current layout, ordered constraints, and the panel
 * the separator controls.
 * @returns The values for aria-valuenow, aria-valuemin, and aria-valuemax.
 */
function calculateSeparatorAriaValues(options: {
  layout: SplitViewLayout
  panelConstraints: readonly SplitViewPanelConstraints[]
  panelId: string
  panelIndex: number
}): { valueMax: number; valueMin: number; valueNow: number | undefined } {
  const { layout, panelConstraints, panelId, panelIndex } = options

  let valueMax = 100
  let valueMin = 0

  const panelSize = layout[panelId]
  const constraints = panelConstraints.find(
    (current) => current.panelId === panelId,
  )

  if (constraints && panelSize !== undefined) {
    const pivotIndices: [number, number] = [panelIndex, panelIndex + 1]
    const targetMin = constraints.collapsible
      ? constraints.collapsedSize
      : constraints.minSize

    const minSizeLayout = validatePanelGroupLayout({
      layout: adjustLayoutByDelta({
        delta: targetMin - panelSize,
        initialLayout: layout,
        panelConstraints,
        pivotIndices,
        prevLayout: layout,
        trigger: "keyboard",
      }),
      panelConstraints,
    })

    valueMin = minSizeLayout[panelId]

    const maxSizeLayout = validatePanelGroupLayout({
      layout: adjustLayoutByDelta({
        delta: constraints.maxSize - panelSize,
        initialLayout: layout,
        panelConstraints,
        pivotIndices,
        prevLayout: layout,
        trigger: "keyboard",
      }),
      panelConstraints,
    })

    valueMax = maxSizeLayout[panelId]
  }

  return { valueMax, valueMin, valueNow: panelSize }
}

/**
 * Turns a size the way a developer wrote it into a percentage of the group.
 *
 * @example
 * ```txt
 * (25, ...)         → 25          plain numbers are percentages
 * ("25%", ...)      → 25
 * ("240px", 960)    → 25          pixels ÷ group width
 * ("240px", 0)      → undefined   can't convert yet, group not measured
 * (-5, ...)         → undefined   negative and broken sizes are ignored
 * ```
 *
 * @param size - The written size: a percentage number, "Npx", or "N%".
 * @param groupSizePixels - The group's current size in pixels.
 * @returns The matching percentage, or undefined when it cannot be known.
 */
function resolveSizeToPercentage(
  size: SplitViewSize | undefined,
  groupSizePixels: number,
): number | undefined {
  if (size === undefined) {
    return undefined
  }

  if (typeof size === "number") {
    return Number.isFinite(size) && size >= 0
      ? formatLayoutNumber(size)
      : undefined
  }

  const value = parseFloat(size)

  if (!Number.isFinite(value) || value < 0) {
    return undefined
  }

  if (size.endsWith("px")) {
    return groupSizePixels > 0
      ? formatLayoutNumber((value / groupSizePixels) * 100)
      : undefined
  }

  return formatLayoutNumber(value)
}

export {
  adjustLayoutByDelta,
  calculateDefaultLayout,
  calculateSeparatorAriaValues,
  compareLayoutNumbers,
  formatLayoutNumber,
  layoutNumbersEqual,
  resolveSizeToPercentage,
  splitViewLayoutsEqual,
  validatePanelGroupLayout,
  validatePanelSize,
  type SplitViewLayout,
  type SplitViewPanelConstraints,
  type SplitViewResizeTrigger,
  type SplitViewSize,
}
