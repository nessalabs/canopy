"use client"

/** @responsibility Renders a controlled group of resizable panels and orchestrates pointer and keyboard resizing. */

import * as React from "react"

import { cn } from "@/lib/utils"

import {
  SplitViewContext,
  composeRefs,
  sortByDocumentPosition,
  type RegisteredSplitViewPanel,
  type SplitViewContextValue,
  type SplitViewSeparatorAria,
} from "./split-view-context"
import {
  adjustLayoutByDelta,
  calculateDefaultLayout,
  calculateSeparatorAriaValues,
  layoutNumbersEqual,
  resolveSizeToPercentage,
  splitViewLayoutsEqual,
  validatePanelGroupLayout,
  type SplitViewLayout,
  type SplitViewPanelConstraints,
  type SplitViewResizeTrigger,
} from "./split-view-math"
import { SplitViewOrientation } from "./split-view-options"

/** Context accompanying every SplitView layout notification. */
interface SplitViewChangeMeta {
  /** The interaction that produced the change. */
  trigger: SplitViewResizeTrigger
}

/** State snapshotted for the lifetime of one pointer resize gesture. */
interface SplitViewDragState {
  separatorId: string
  /** The pointer that started the gesture; other pointers are ignored. */
  pointerId: number
  pivotIndices: [number, number]
  initialLayout: SplitViewLayout
  /** The most recent layout the gesture produced, committed on release. */
  latestLayout: SplitViewLayout
  startX: number
  startY: number
  groupSizePixels: number
  rightToLeft: boolean
  changed: boolean
}

/** Properties accepted by the SplitView group. */
interface SplitViewProps extends React.ComponentProps<"div"> {
  /**
   * The axis along which panels are laid out.
   * @defaultValue SplitViewOrientation.Horizontal
   */
  orientation?: SplitViewOrientation
  /**
   * Percentage layout keyed by panel id when the group is controlled by its
   * consumer. Interactions report the next layout through `onLayoutChange`;
   * the consumer renders it back through this property.
   */
  layout?: SplitViewLayout
  /** Initial percentage layout for an uncontrolled group. */
  defaultLayout?: SplitViewLayout
  /**
   * Called with the next layout on every step of an interaction, including
   * each pointer move. Persist from `onLayoutCommit` instead.
   */
  onLayoutChange?: (layout: SplitViewLayout, meta: SplitViewChangeMeta) => void
  /** Called once per settled gesture with the final layout. */
  onLayoutCommit?: (layout: SplitViewLayout, meta: SplitViewChangeMeta) => void
  /**
   * Percentage applied by one arrow-key press on a separator.
   * @defaultValue 5
   */
  keyboardResizeStep?: number
}

/**
 * Measures the group's usable extent: the sum of panel sizes along the
 * group's axis, excluding separators.
 *
 * @param panels - The registered panels in visual order.
 * @param orientation - The group's layout axis.
 * @returns The usable extent in pixels.
 */
function measureGroupSize(
  panels: readonly RegisteredSplitViewPanel[],
  orientation: SplitViewOrientation,
): number {
  return panels.reduce(
    (total, panel) =>
      total +
      (orientation === SplitViewOrientation.Horizontal
        ? panel.element.offsetWidth
        : panel.element.offsetHeight),
    0,
  )
}

/**
 * Renders a group of resizable panels separated by interactive separators.
 *
 * Compose direct children as `SplitViewPanel` and `SplitViewSeparator`
 * elements, alternating so every separator sits between two panels. The
 * group is fully controlled when `layout` is provided; state then lives with
 * the consumer and nothing is persisted internally.
 *
 * @param props - Orientation, controlled or uncontrolled layout, change
 * callbacks, and native container properties.
 * @returns A flex container coordinating its registered panels.
 */
function SplitView({
  orientation = SplitViewOrientation.Horizontal,
  layout: layoutProp,
  defaultLayout,
  onLayoutChange,
  onLayoutCommit,
  keyboardResizeStep = 5,
  className,
  children,
  ref,
  ...props
}: SplitViewProps) {
  const groupRef = React.useRef<HTMLDivElement>(null)
  // Memoized so React does not detach and re-attach refs on every render.
  const composedGroupRef = React.useMemo(
    () => composeRefs(groupRef, ref),
    [ref],
  )
  const registrationsRef = React.useRef({
    panels: new Map<string, RegisteredSplitViewPanel>(),
    separators: new Map<string, HTMLElement>(),
  })
  const [registrationVersion, setRegistrationVersion] = React.useState(0)
  const [groupSizePixels, setGroupSizePixels] = React.useState(0)
  const [internalLayout, setInternalLayout] = React.useState<
    SplitViewLayout | undefined
  >(defaultLayout)
  const [activeSeparatorId, setActiveSeparatorId] = React.useState<
    string | null
  >(null)
  const dragStateRef = React.useRef<SplitViewDragState | null>(null)
  const expandedSizesRef = React.useRef<Record<string, number>>({})

  const orderedPanels = React.useMemo(() => {
    void registrationVersion
    return sortByDocumentPosition(
      [...registrationsRef.current.panels.values()],
      (panel) => panel.element,
    )
  }, [registrationVersion])

  const orderedSeparatorIds = React.useMemo(() => {
    void registrationVersion
    return sortByDocumentPosition(
      [...registrationsRef.current.separators.entries()],
      ([, element]) => element,
    ).map(([id]) => id)
  }, [registrationVersion])

  const panelIds = React.useMemo(
    () => orderedPanels.map((panel) => panel.id),
    [orderedPanels],
  )

  const derivedConstraints = React.useMemo<SplitViewPanelConstraints[]>(() => {
    return orderedPanels.map((panel) => {
      if (groupSizePixels <= 0) {
        // A hidden or unmeasured group cannot resolve pixel constraints yet;
        // relaxed constraints keep any provided layout renderable meanwhile.
        return {
          panelId: panel.id,
          minSize: 0,
          maxSize: 100,
          collapsedSize: 0,
          collapsible: panel.constraints.collapsible === true,
          defaultSize: resolveSizeToPercentage(
            typeof panel.constraints.defaultSize === "number"
              ? panel.constraints.defaultSize
              : undefined,
            groupSizePixels,
          ),
        }
      }

      const minSize =
        resolveSizeToPercentage(panel.constraints.minSize, groupSizePixels) ?? 0
      const maxSize =
        resolveSizeToPercentage(panel.constraints.maxSize, groupSizePixels) ??
        100
      const collapsedSize =
        resolveSizeToPercentage(
          panel.constraints.collapsedSize,
          groupSizePixels,
        ) ?? 0

      return {
        panelId: panel.id,
        minSize,
        // A max written smaller than the min would be impossible; the min
        // wins and the max is raised to meet it.
        maxSize: Math.max(minSize, maxSize),
        // A collapsed size above the minimum would invert the collapse
        // snapping thresholds, so it is clamped to the minimum size.
        collapsedSize: Math.min(collapsedSize, minSize),
        collapsible: panel.constraints.collapsible === true,
        defaultSize: resolveSizeToPercentage(
          panel.constraints.defaultSize,
          groupSizePixels,
        ),
      }
    })
  }, [groupSizePixels, orderedPanels])

  const renderedLayout = React.useMemo<SplitViewLayout>(() => {
    if (panelIds.length === 0) {
      return {}
    }

    const source = layoutProp ?? internalLayout
    // The source layout is used only when it names exactly our panels with
    // usable numbers; anything else falls back to a computed default.
    const sourceMatches =
      source !== undefined &&
      panelIds.length === Object.keys(source).length &&
      panelIds.every(
        (id) =>
          typeof source[id] === "number" &&
          Number.isFinite(source[id]) &&
          source[id] >= 0,
      )

    const ordered: SplitViewLayout = {}

    if (sourceMatches) {
      for (const id of panelIds) {
        ordered[id] = source[id]
      }

      return validatePanelGroupLayout({
        layout: ordered,
        panelConstraints: derivedConstraints,
      })
    }

    return validatePanelGroupLayout({
      layout: calculateDefaultLayout(derivedConstraints),
      panelConstraints: derivedConstraints,
    })
  }, [derivedConstraints, internalLayout, layoutProp, panelIds])

  const renderedLayoutRef = React.useRef(renderedLayout)
  renderedLayoutRef.current = renderedLayout

  React.useEffect(() => {
    // The last comfortably expanded size per collapsible panel backs the
    // Enter-key collapse toggle on separators.
    for (const constraints of derivedConstraints) {
      const size = renderedLayout[constraints.panelId]

      if (
        constraints.collapsible &&
        size !== undefined &&
        !layoutNumbersEqual(size, constraints.collapsedSize)
      ) {
        expandedSizesRef.current[constraints.panelId] = size
      }
    }
  }, [derivedConstraints, renderedLayout])

  React.useEffect(() => {
    const group = groupRef.current

    if (!group || typeof ResizeObserver === "undefined") {
      return
    }

    const measure = () => {
      setGroupSizePixels(measureGroupSize(orderedPanels, orientation))
    }

    measure()

    const observer = new ResizeObserver(measure)
    observer.observe(group)

    return () => observer.disconnect()
  }, [orderedPanels, orientation])

  const applyChange = React.useCallback(
    (next: SplitViewLayout, meta: SplitViewChangeMeta) => {
      const changed = !splitViewLayoutsEqual(next, renderedLayoutRef.current)

      if (changed) {
        if (layoutProp === undefined) {
          setInternalLayout(next)
        }

        onLayoutChange?.(next, meta)
      }

      return changed
    },
    [layoutProp, onLayoutChange],
  )

  const registerPanel = React.useCallback(
    (panel: RegisteredSplitViewPanel) => {
      registrationsRef.current.panels.set(panel.id, panel)
      setRegistrationVersion((version) => version + 1)

      return () => {
        registrationsRef.current.panels.delete(panel.id)
        setRegistrationVersion((version) => version + 1)
      }
    },
    [],
  )

  const registerSeparator = React.useCallback(
    (id: string, element: HTMLElement) => {
      registrationsRef.current.separators.set(id, element)
      setRegistrationVersion((version) => version + 1)

      return () => {
        registrationsRef.current.separators.delete(id)
        setRegistrationVersion((version) => version + 1)
      }
    },
    [],
  )

  const getSeparatorPivot = React.useCallback(
    (separatorId: string): [number, number] | undefined => {
      const index = orderedSeparatorIds.indexOf(separatorId)

      if (index === -1 || index + 1 >= panelIds.length) {
        return undefined
      }

      return [index, index + 1]
    },
    [orderedSeparatorIds, panelIds],
  )

  const getSeparatorAria = React.useCallback(
    (separatorId: string): SplitViewSeparatorAria | undefined => {
      const pivot = getSeparatorPivot(separatorId)

      if (!pivot) {
        return undefined
      }

      const panelId = panelIds[pivot[0]]
      const values = calculateSeparatorAriaValues({
        layout: renderedLayout,
        panelConstraints: derivedConstraints,
        panelId,
        panelIndex: pivot[0],
      })

      return { controls: panelId, ...values }
    },
    [derivedConstraints, getSeparatorPivot, panelIds, renderedLayout],
  )

  const onSeparatorPointerDown = React.useCallback(
    (separatorId: string, event: React.PointerEvent<HTMLElement>) => {
      const pivot = getSeparatorPivot(separatorId)

      if (!pivot || event.button !== 0 || dragStateRef.current) {
        return
      }

      const group = groupRef.current
      const size = measureGroupSize(orderedPanels, orientation)

      if (!group || size <= 0) {
        return
      }

      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // Synthetic pointer events (tests) have no capturable pointer id;
        // resizing still works through the element's own move events.
      }

      dragStateRef.current = {
        separatorId,
        pointerId: event.pointerId,
        pivotIndices: pivot,
        initialLayout: renderedLayoutRef.current,
        latestLayout: renderedLayoutRef.current,
        startX: event.clientX,
        startY: event.clientY,
        groupSizePixels: size,
        rightToLeft: getComputedStyle(group).direction === "rtl",
        changed: false,
      }

      setActiveSeparatorId(separatorId)
    },
    [getSeparatorPivot, orderedPanels, orientation],
  )

  const onSeparatorPointerMove = React.useCallback(
    (separatorId: string, event: React.PointerEvent<HTMLElement>) => {
      const dragState = dragStateRef.current

      if (
        !dragState ||
        dragState.separatorId !== separatorId ||
        dragState.pointerId !== event.pointerId
      ) {
        return
      }

      const pixelDelta =
        orientation === SplitViewOrientation.Horizontal
          ? (event.clientX - dragState.startX) * (dragState.rightToLeft ? -1 : 1)
          : event.clientY - dragState.startY

      const next = adjustLayoutByDelta({
        delta: (pixelDelta / dragState.groupSizePixels) * 100,
        initialLayout: dragState.initialLayout,
        panelConstraints: derivedConstraints,
        pivotIndices: dragState.pivotIndices,
        prevLayout: dragState.latestLayout,
        trigger: "pointer",
      })

      dragState.latestLayout = next

      if (applyChange(next, { trigger: "pointer" })) {
        dragState.changed = true
      }
    },
    [applyChange, derivedConstraints, orientation],
  )

  const onSeparatorPointerEnd = React.useCallback(
    (separatorId: string, event: React.PointerEvent<HTMLElement>) => {
      const dragState = dragStateRef.current

      // Runs for pointer up, cancel, and lost capture; whichever arrives
      // first wins and the rest quietly do nothing.
      if (
        !dragState ||
        dragState.separatorId !== separatorId ||
        dragState.pointerId !== event.pointerId
      ) {
        return
      }

      dragStateRef.current = null
      setActiveSeparatorId(null)

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }

      if (dragState.changed) {
        // The gesture's own latest layout is committed rather than the
        // rendered one: a controlled consumer may not have re-rendered yet.
        onLayoutCommit?.(dragState.latestLayout, { trigger: "pointer" })
      }
    },
    [onLayoutCommit],
  )

  const onSeparatorKeyDown = React.useCallback(
    (separatorId: string, event: React.KeyboardEvent<HTMLElement>) => {
      if (event.defaultPrevented) {
        return
      }

      const pivot = getSeparatorPivot(separatorId)

      if (!pivot) {
        return
      }

      const group = groupRef.current
      const rightToLeft = group
        ? getComputedStyle(group).direction === "rtl"
        : false
      const horizontal = orientation === SplitViewOrientation.Horizontal

      let delta: number | undefined

      switch (event.key) {
        case "ArrowLeft":
          if (horizontal) delta = rightToLeft ? keyboardResizeStep : -keyboardResizeStep
          break
        case "ArrowRight":
          if (horizontal) delta = rightToLeft ? -keyboardResizeStep : keyboardResizeStep
          break
        case "ArrowUp":
          if (!horizontal) delta = -keyboardResizeStep
          break
        case "ArrowDown":
          if (!horizontal) delta = keyboardResizeStep
          break
        case "Home":
          delta = -100
          break
        case "End":
          delta = 100
          break
        case "Enter": {
          const panelId = panelIds[pivot[0]]
          const constraints = derivedConstraints[pivot[0]]
          const size = renderedLayoutRef.current[panelId]

          if (constraints?.collapsible && size !== undefined) {
            delta = layoutNumbersEqual(size, constraints.collapsedSize)
              ? (expandedSizesRef.current[panelId] ?? constraints.minSize) - size
              : constraints.collapsedSize - size
          }
          break
        }
      }

      if (delta === undefined) {
        return
      }

      event.preventDefault()

      const next = adjustLayoutByDelta({
        delta,
        initialLayout: renderedLayoutRef.current,
        panelConstraints: derivedConstraints,
        pivotIndices: pivot,
        prevLayout: renderedLayoutRef.current,
        trigger: "keyboard",
      })

      if (applyChange(next, { trigger: "keyboard" })) {
        onLayoutCommit?.(next, { trigger: "keyboard" })
      }
    },
    [
      applyChange,
      derivedConstraints,
      getSeparatorPivot,
      keyboardResizeStep,
      onLayoutCommit,
      orientation,
      panelIds,
    ],
  )

  const contextValue = React.useMemo<SplitViewContextValue>(
    () => ({
      orientation,
      layout: renderedLayout,
      derivedConstraints,
      panelIds,
      activeSeparatorId,
      registerPanel,
      registerSeparator,
      getSeparatorAria,
      onSeparatorPointerDown,
      onSeparatorPointerMove,
      onSeparatorPointerEnd,
      onSeparatorKeyDown,
    }),
    [
      activeSeparatorId,
      derivedConstraints,
      getSeparatorAria,
      onSeparatorKeyDown,
      onSeparatorPointerDown,
      onSeparatorPointerEnd,
      onSeparatorPointerMove,
      orientation,
      panelIds,
      registerPanel,
      registerSeparator,
      renderedLayout,
    ],
  )

  return (
    <SplitViewContext.Provider value={contextValue}>
      {/* Consumer props spread first so the attributes the group owns
          (slot, orientation, ref) always win. */}
      <div
        {...props}
        ref={composedGroupRef}
        data-slot="split-view"
        data-orientation={orientation}
        className={cn(
          "flex h-full w-full min-h-0 min-w-0 overflow-hidden data-[orientation=vertical]:flex-col",
          className,
        )}
      >
        {children}
      </div>
    </SplitViewContext.Provider>
  )
}

export { SplitView, type SplitViewChangeMeta, type SplitViewProps }
