import * as React from "react"

import { cn } from "@/lib/utils"

import { Arrowheads, CARD_BUTTON, DiagramFrame, STATUS, shorten, statusItems, useMeasure, type ChangeMapStatus, type LegendItem } from "../change-map/diagram-parts"
import { layoutCallFlow } from "./call-flow-layout"

export interface CallFlowParticipant {
  id: string
  /** A class, a service, a module. */
  label: string
  /** A second line, typically the file it lives in. */
  detail?: string
  status: ChangeMapStatus
}

export interface CallFlowStep {
  from: string
  to: string
  /** What is called or returned — `issue(amount)`, `RefundId`. */
  label: string
  /** More about the step; shown on hover. */
  detail?: string
  /** `return` draws a dashed arrow back, `async` an open arrowhead. */
  kind?: "call" | "return" | "async"
  status?: "added" | "modified" | "deleted" | "unchanged"
  /** Consecutive steps on the same branch are wrapped in a band with this name — `amount over limit`. */
  branch?: string
}

export interface CallFlowProps extends Omit<React.ComponentProps<"section">, "title"> {
  participants: readonly CallFlowParticipant[]
  steps: readonly CallFlowStep[]
  title?: React.ReactNode
  caption?: React.ReactNode
  /** Makes participants buttons — the place to open their code. */
  onSelectParticipant?: (participant: CallFlowParticipant) => void
  /** Makes each step's label a button. */
  onSelectStep?: (step: CallFlowStep, index: number) => void
}

const SIZE = { headerHeight: 52, rowHeight: 50, minGap: 48, loopWidth: 30, branchLabelHeight: 24 }
const PAD = 24
const CARD = { min: 120, max: 240, chrome: 32 }
const LABEL_CHARS = 40

/** Each step's colour: the arrow, and the number on the caller's lifeline. */
const STEP_TONE: Record<NonNullable<CallFlowStep["status"]>, { stroke: string; badge: string; label: string }> = {
  added: { stroke: "stroke-nessa-diff-addition", badge: "bg-nessa-diff-addition text-background", label: "New step" },
  modified: { stroke: "stroke-nessa-diff-modification", badge: "bg-nessa-diff-modification text-background", label: "Changed step" },
  deleted: { stroke: "stroke-nessa-diff-deletion", badge: "bg-nessa-diff-deletion text-background", label: "Removed step" },
  unchanged: { stroke: "stroke-muted-foreground/70", badge: "bg-muted-foreground text-background", label: "Unchanged step" },
}

/**
 * A runtime path through a change as a sequence diagram: the participants as cards across the
 * top with lifelines below, each step a numbered arrow between two of them, read top to bottom.
 * Steps are coloured by whether the change added, changed or removed them; returns are dashed,
 * async calls open-headed, and a run of steps on one branch sits in a named band.
 */
function CallFlow({ participants, steps, title, caption, onSelectParticipant, onSelectStep, className, ...props }: CallFlowProps) {
  const root = React.useRef<HTMLElement>(null)
  const measure = useMeasure(root)
  const layout = React.useMemo(
    () =>
      layoutCallFlow({
        ...SIZE,
        participants: participants.map((p) => {
          const text = Math.max(measure(p.label, 14, "sans", 600), p.detail ? measure(p.detail, 12, "mono") : 0)
          return { id: p.id, width: Math.round(Math.min(CARD.max, Math.max(CARD.min, text + CARD.chrome))) }
        }),
        steps: steps.map((step) => ({ from: step.from, to: step.to, branch: step.branch, labelWidth: Math.ceil(measure(shorten(step.label, LABEL_CHARS), 12, "mono")) + 8 })),
      }),
    [participants, steps, measure],
  )
  const arrow = React.useId()
  const tones = [...new Set(steps.map((step) => step.status ?? "unchanged"))]
  const legend: LegendItem[] = [
    ...statusItems(participants.map((p) => p.status)),
    ...(tones.length > 1 ? tones.filter((tone) => tone !== "unchanged").map((tone) => ({ key: `step-${tone}`, label: STEP_TONE[tone].label, swatch: cn("border-0", STEP_TONE[tone].badge) })) : []),
  ]

  const canvas = (
    <div className="relative" style={{ width: layout.width + PAD * 2, height: layout.height + PAD * 2 }}>
      {layout.branches.map((band, i) => (
        <div key={i} className="absolute rounded-xl border border-dashed border-border bg-muted/30" style={{ left: band.x + PAD, top: band.y + PAD, width: band.width, height: band.height }}>
          <span title={band.label} className="absolute -top-2.5 left-3 max-w-[90%] truncate rounded bg-card px-1.5 nessa-text-2 font-medium text-muted-foreground">
            {shorten(band.label, 48)}
          </span>
        </div>
      ))}
      <svg aria-hidden="true" className="absolute inset-0 size-full overflow-visible">
        <Arrowheads id={arrow} />
        <g transform={`translate(${PAD} ${PAD})`}>
          {[...layout.lifelines].map(([id, x]) => (
            <line key={id} x1={x} x2={x} y1={SIZE.headerHeight} y2={layout.height} strokeDasharray="3 4" className="stroke-border" strokeWidth={1.25} />
          ))}
          {layout.steps.map((placed) => {
            const step = steps[placed.index]!
            const kind = step.kind ?? "call"
            return (
              <path
                key={placed.index}
                d={placed.path}
                strokeWidth={1.5}
                strokeDasharray={kind === "return" ? "5 4" : step.status === "deleted" ? "2 3" : undefined}
                markerEnd={`url(#${arrow}-${kind === "async" ? "open" : "dim"})`}
                className={cn("fill-none", STEP_TONE[step.status ?? "unchanged"].stroke)}
              />
            )
          })}
        </g>
      </svg>
      {participants.map((p) => {
        const at = layout.boxes.get(p.id)!
        const body = (
          <>
            <span className="truncate nessa-text-4 font-semibold">{p.label}</span>
            {p.detail ? <span className="truncate font-mono nessa-text-2 text-muted-foreground">{p.detail}</span> : null}
          </>
        )
        const box = cn("absolute flex flex-col justify-center gap-0.5 rounded-xl border-2 px-3 text-left", STATUS[p.status].card)
        const place = { left: at.x + PAD, top: at.y + PAD, width: at.width, height: at.height }
        return onSelectParticipant ? (
          <button key={p.id} type="button" title={p.detail ?? p.label} className={cn(box, CARD_BUTTON)} style={place} onClick={() => onSelectParticipant(p)}>
            {body}
          </button>
        ) : (
          <div key={p.id} title={p.detail ?? p.label} className={box} style={place}>
            {body}
          </div>
        )
      })}
      {layout.steps.map((placed, order) => {
        const step = steps[placed.index]!
        const tone = STEP_TONE[step.status ?? "unchanged"]
        const label = shorten(step.label, LABEL_CHARS)
        const full = step.detail ? `${step.label} — ${step.detail}` : step.label
        const text = cn(
          "absolute whitespace-nowrap rounded px-1 font-mono nessa-text-2 text-foreground",
          placed.self ? "-translate-y-1/2" : "-translate-x-1/2 -translate-y-1/2",
          step.status === "deleted" && "line-through text-muted-foreground",
        )
        const place = { left: placed.label.x + PAD, top: placed.label.y + PAD, maxWidth: Math.max(48, placed.labelRoom) }
        return (
          <React.Fragment key={placed.index}>
            <span
              className={cn("absolute flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full nessa-text-1 font-semibold tabular-nums", tone.badge)}
              style={{ left: placed.fromX + PAD, top: placed.y + PAD }}
            >
              {order + 1}
            </span>
            {onSelectStep ? (
              <button type="button" title={full} className={cn(text, "truncate hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring")} style={place} onClick={() => onSelectStep(step, placed.index)}>
                {label}
              </button>
            ) : (
              <span title={full} className={cn(text, "truncate")} style={place}>
                {label}
              </span>
            )}
          </React.Fragment>
        )
      })}
    </div>
  )

  return (
    <DiagramFrame rootRef={root} slot="call-flow" title={title ?? "Call flow"} legend={legend} caption={caption} canvas={canvas} refitKey={layout} expandLabel="Expand call flow" className={className} {...props} />
  )
}

export { CallFlow }
