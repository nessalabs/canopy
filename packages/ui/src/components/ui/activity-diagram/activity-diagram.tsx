import * as React from "react"

import { cn } from "@/lib/utils"

import type { ChangeMapStatus, StatusLabels } from "../change-map/diagram-parts"
import { TopDownDiagram, fitText, fixedSize, type TopDownShape } from "../top-down-diagram/top-down-diagram"

export interface ActivityStep {
  id: string
  /** What happens — `Validate input`; for a decision, the question — `Valid?`. */
  label: string
  /** A second line under an action; the tooltip on other kinds. */
  detail?: string
  /** Tints the step by how a change touches it; neutral when absent. */
  status?: ChangeMapStatus
  /**
   * `action` a card, `decision` a diamond, `fork` and `join` a bar, `start` a filled circle and
   * `end` a ringed one. Start steps begin the layout.
   */
  kind: "start" | "end" | "action" | "decision" | "fork" | "join"
}

export interface ActivityFlow {
  from: string
  to: string
  /** Drawn on the edge — a decision's `yes` / `no`, a condition. */
  label?: string
}

export interface ActivityDiagramProps extends Omit<React.ComponentProps<"section">, "title" | "onSelect"> {
  steps: readonly ActivityStep[]
  flows: readonly ActivityFlow[]
  title?: React.ReactNode
  /** A line under the diagram — what it models, what a click does. */
  caption?: React.ReactNode
  /** Words for the legend's statuses in place of the built-in ones ("Added", "Modified", …); colours stay. */
  statusLabels?: StatusLabels
  /** The step shown as picked; its flows are drawn in full. */
  selectedId?: string
  /** Makes every step a button — the place to drill into it. Without it the diagram is a picture. */
  onSelect?: (step: ActivityStep) => void
  /** `bare` draws only the diagram at its natural size — no frame, header or scrolling — for hosts that frame it themselves (a canvas). */
  bare?: boolean
}

const CARD: TopDownShape = { outline: "rounded-xl border-2", size: fitText(36), text: "full" }

/** A decision's height over its width: fixed, so its slanted borders keep one weight once squashed. */
const DIAMOND_ASPECT = 0.4

/** A decision: a square turned on its corner and squashed into the node's box; it shows its label alone. */
const DIAMOND: TopDownShape = {
  outline: cn(CARD.outline, "rounded-md border-4"),
  size: (text) => {
    const width = Math.round(Math.min(240, Math.max(140, text / 0.6 + 24)))
    return { width, height: Math.round(width * DIAMOND_ASPECT) }
  },
  text: "label",
  style: ({ width, height }) => {
    const side = width / Math.SQRT2
    return { width: side, height: side, left: (width - side) / 2, top: (height - side) / 2, transform: `scaleY(${DIAMOND_ASPECT}) rotate(45deg)` }
  },
}
const BAR: TopDownShape = { outline: "rounded-full", size: fixedSize(140, 8), text: "none", look: "bg-foreground" }
const DOT: TopDownShape = { outline: "rounded-full", size: fixedSize(22, 22), text: "none", look: "bg-foreground" }

/** Each kind's notation: start a filled circle, end a ringed one, fork and join a bar. */
const SHAPE: Record<ActivityStep["kind"], TopDownShape> = {
  start: DOT,
  end: { ...DOT, outline: cn(DOT.outline, "border-2 bg-clip-content p-[3px]"), size: fixedSize(26, 26), look: "border-foreground bg-foreground" },
  action: CARD,
  decision: DIAMOND,
  fork: BAR,
  join: BAR,
}

/**
 * A UML activity diagram — a flowchart — read top to bottom: actions as cards, decisions as
 * diamonds with their outcomes (`yes`, `no`) on the flows leaving them, forks and joins as bars,
 * start and end as circles. Steps are layered by their longest path from the start; flows that
 * loop back run up lanes to the right. With `onSelect` every step is a button. Scrolls sideways
 * when wider than its column. Each step carries `data-node-id` so a host can find it.
 */
function ActivityDiagram({ steps, flows, title, caption, selectedId, onSelect, ...props }: ActivityDiagramProps) {
  const nodes = React.useMemo(() => steps.map((step) => ({ ...step, shape: SHAPE[step.kind] })), [steps])
  const roots = React.useMemo(() => steps.filter((step) => step.kind === "start").map((step) => step.id), [steps])
  return (
    <TopDownDiagram
      slot="activity-diagram"
      title={title ?? "Activity"}
      expandLabel="Expand activity diagram"
      nodes={nodes}
      edges={flows}
      roots={roots}
      caption={caption}
      selectedId={selectedId}
      onSelect={onSelect && ((index) => onSelect(steps[index]!))}
      {...props}
    />
  )
}

export { ActivityDiagram }
