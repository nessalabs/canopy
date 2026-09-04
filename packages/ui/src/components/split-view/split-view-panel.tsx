import * as React from "react"

import { cn } from "@/lib/utils"

import {
  composeRefs,
  useSplitView,
  type SplitViewPanelSizeProps,
} from "./split-view-context"
import { layoutNumbersEqual } from "./split-view-math"

/** Properties accepted by one SplitView panel. */
interface SplitViewPanelProps
  extends Omit<React.ComponentProps<"div">, "id">,
    SplitViewPanelSizeProps {
  /**
   * Unique id of the panel within its group. Keys the group layout and is
   * rendered as the element id so separators can reference it.
   */
  id: string
}

/**
 * Renders one panel of a SplitView. The panel's size always comes from the
 * group layout; the panel itself holds no sizing state.
 *
 * @param props - The panel id, authored sizing constraints, and native
 * container properties.
 * @returns A flex child sized by the group's current layout.
 */
function SplitViewPanel({
  id,
  minSize,
  maxSize,
  defaultSize,
  collapsedSize,
  collapsible,
  className,
  style,
  children,
  ref,
  ...props
}: SplitViewPanelProps) {
  const { derivedConstraints, layout, registerPanel } = useSplitView()
  const elementRef = React.useRef<HTMLDivElement>(null)
  // Memoized so React does not detach and re-attach refs on every render.
  const composedRef = React.useMemo(() => composeRefs(elementRef, ref), [ref])

  React.useLayoutEffect(() => {
    const element = elementRef.current

    if (!element) {
      return
    }

    return registerPanel({
      id,
      element,
      constraints: { minSize, maxSize, defaultSize, collapsedSize, collapsible },
    })
  }, [
    collapsedSize,
    collapsible,
    defaultSize,
    id,
    maxSize,
    minSize,
    registerPanel,
  ])

  const size = layout[id]
  const constraints = derivedConstraints.find(
    (current) => current.panelId === id,
  )
  const collapsed =
    constraints?.collapsible === true &&
    size !== undefined &&
    layoutNumbersEqual(size, constraints.collapsedSize)

  return (
    // Consumer props spread first so the attributes the panel owns
    // (id, slot, sizing style, ref) always win.
    <div
      {...props}
      ref={composedRef}
      id={id}
      data-slot="split-view-panel"
      data-collapsed={collapsed || undefined}
      className={cn(
        "relative flex min-h-0 min-w-0 flex-col overflow-hidden",
        className,
      )}
      style={{
        ...style,
        flexBasis: 0,
        flexGrow: size ?? 1,
        flexShrink: 1,
      }}
    >
      {children}
    </div>
  )
}

export { SplitViewPanel, type SplitViewPanelProps }
