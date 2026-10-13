import * as React from "react"

import { cn } from "@/lib/utils"

import type { ChangeMapStatus, StatusLabels } from "../change-map/diagram-parts"
import { TopDownDiagram, fitText, type TopDownShape } from "../top-down-diagram/top-down-diagram"

export interface StateMachineState {
  id: string
  /** The state's name — `Pending`, `Reviewing`. */
  label: string
  /** A second line — what holds in this state, where it is handled. */
  detail?: string
  /** Tints the state by how a change touches it; neutral when absent. */
  status?: ChangeMapStatus
  /** `initial` draws a pill and starts the layout; `final` draws a double border. Defaults to `normal`. */
  kind?: "initial" | "final" | "normal"
}

export interface StateMachineTransition {
  from: string
  to: string
  /** The event that fires it — `submit`, `timeout`. */
  label?: string
  /** The condition it waits on, drawn as `[guard]` after the event. */
  guard?: string
}

export interface StateMachineProps extends Omit<React.ComponentProps<"section">, "title" | "onSelect"> {
  states: readonly StateMachineState[]
  transitions: readonly StateMachineTransition[]
  title?: React.ReactNode
  /** A line under the diagram — what it models, what a click does. */
  caption?: React.ReactNode
  /** Words for the legend's statuses in place of the built-in ones ("Added", "Modified", …); colours stay. */
  statusLabels?: StatusLabels
  /** The state shown as picked; its transitions are drawn in full. */
  selectedId?: string
  /** Makes every state a button — the place to drill into it. Without it the diagram is a picture. */
  onSelect?: (state: StateMachineState) => void
  /** `bare` draws only the diagram at its natural size — no frame, header or scrolling — for hosts that frame it themselves (a canvas). */
  bare?: boolean
}

const CARD: TopDownShape = { outline: "rounded-xl border-2", size: fitText(36), text: "full" }

/** An ordinary state is a card, the initial state a pill, a final state a card with a double border. */
const SHAPE: Record<NonNullable<StateMachineState["kind"]>, TopDownShape> = {
  initial: { ...CARD, outline: cn(CARD.outline, "rounded-full"), size: fitText(52) },
  final: { ...CARD, outline: cn(CARD.outline, "border-[6px] border-double"), size: fitText(44) },
  normal: CARD,
}

/** A transition's label: its event, then its guard in brackets. */
const transitionLabel = ({ label, guard }: Pick<StateMachineTransition, "label" | "guard">): string | undefined =>
  [label, guard ? `[${guard}]` : undefined].filter(Boolean).join(" ") || undefined

/**
 * A state machine read top to bottom: states layered by their longest path from the initial
 * state, transitions labelled with their event and `[guard]`, and transitions that loop back
 * routed up lanes to the right. The initial state is a pill and final states carry a double
 * border; states are tinted by how a change touches them. With `onSelect` every state is a
 * button. Scrolls sideways when wider than its column. Each state carries `data-node-id` so a
 * host can find it.
 */
function StateMachine({ states, transitions, title, caption, selectedId, onSelect, ...props }: StateMachineProps) {
  const nodes = React.useMemo(() => states.map((state) => ({ ...state, shape: SHAPE[state.kind ?? "normal"] })), [states])
  const edges = React.useMemo(() => transitions.map((transition) => ({ from: transition.from, to: transition.to, label: transitionLabel(transition) })), [transitions])
  const roots = React.useMemo(() => states.filter((state) => state.kind === "initial").map((state) => state.id), [states])
  return (
    <TopDownDiagram
      slot="state-machine"
      title={title ?? "State machine"}
      expandLabel="Expand state machine"
      nodes={nodes}
      edges={edges}
      roots={roots}
      caption={caption}
      selectedId={selectedId}
      onSelect={onSelect && ((index) => onSelect(states[index]!))}
      {...props}
    />
  )
}

export { StateMachine }
