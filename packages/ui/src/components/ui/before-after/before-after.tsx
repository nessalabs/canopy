import * as React from "react"

import { cn } from "@/lib/utils"

import { Arrowheads, CARD_BUTTON, DiagramFrame, shorten, useMeasure, type LegendItem } from "../change-map/diagram-parts"
import { layoutBeforeAfter, type BeforeAfterSide } from "./before-after-layout"

export type BeforeAfterChange = "same" | "added" | "removed" | "changed" | "moved"

export interface BeforeAfterPart {
  label: string
  /** A second line, typically the file it lives in. */
  detail?: string
}

export interface BeforeAfterRow {
  id: string
  /** Absent for a part the change adds. */
  before?: BeforeAfterPart
  /** Absent for a part the change removes. */
  after?: BeforeAfterPart
  change: BeforeAfterChange
  /** What changed, in a few words; shown on hover. */
  note?: string
}

export interface BeforeAfterFlow {
  side: BeforeAfterSide
  /** Row ids. */
  from: string
  to: string
  label?: string
}

export interface BeforeAfterProps extends Omit<React.ComponentProps<"section">, "title" | "onSelect"> {
  rows: readonly BeforeAfterRow[]
  flows?: readonly BeforeAfterFlow[]
  title?: React.ReactNode
  caption?: React.ReactNode
  beforeTitle?: string
  afterTitle?: string
  /** Makes every card a button — the place to open that side's code. */
  onSelect?: (row: BeforeAfterRow, side: BeforeAfterSide) => void
}

const SIZE = { cardWidth: 240, rowHeight: 56, rowGap: 14, gutter: 64, headerHeight: 30 }
const PAD = 24
const LABEL_CHARS = 28

const CARD_LOOK = {
  neutral: "border-border bg-card",
  added: "border-nessa-diff-addition/60 bg-nessa-diff-addition/10",
  removed: "border-nessa-diff-deletion/50 bg-nessa-diff-deletion/5 opacity-70",
  changed: "border-nessa-diff-modification/60 bg-nessa-diff-modification/10",
  moved: "border-dashed border-foreground/40 bg-card",
  empty: "border-dashed border-border/70 bg-transparent",
} as const

/** The mark in the strip between the sides, and the word it stands for. */
const MARK: Record<BeforeAfterChange, { symbol: string; word: string; chip: string }> = {
  same: { symbol: "", word: "Unchanged", chip: "size-1.5 bg-muted-foreground/40" },
  added: { symbol: "+", word: "Added", chip: "bg-nessa-diff-addition text-background" },
  removed: { symbol: "−", word: "Removed", chip: "bg-nessa-diff-deletion text-background" },
  changed: { symbol: "~", word: "Changed", chip: "bg-nessa-diff-modification text-background" },
  moved: { symbol: "↕", word: "Moved", chip: "border border-foreground/40 bg-card text-foreground" },
}

/** Which look each side's card takes for a row's change. */
const LOOK: Record<BeforeAfterChange, Record<BeforeAfterSide, keyof typeof CARD_LOOK>> = {
  same: { before: "neutral", after: "neutral" },
  added: { before: "empty", after: "added" },
  removed: { before: "removed", after: "empty" },
  changed: { before: "neutral", after: "changed" },
  moved: { before: "moved", after: "moved" },
}

/**
 * How something worked before a change and how it works after, side by side: every part on its
 * own row at the same height on both sides, so a reader's eye goes straight across. The strip
 * between marks each row added, removed, changed or moved; flows within a side run in a lane
 * outside it.
 */
function BeforeAfter({ rows, flows = [], title, caption, beforeTitle = "Before", afterTitle = "After", onSelect, className, ...props }: BeforeAfterProps) {
  const root = React.useRef<HTMLElement>(null)
  const measure = useMeasure(root)
  const layout = React.useMemo(
    () => layoutBeforeAfter({ ...SIZE, rows, flows: flows.map((flow) => ({ ...flow, labelWidth: flow.label ? Math.ceil(measure(shorten(flow.label, LABEL_CHARS), 12, "mono")) + 4 : 0 })) }),
    [rows, flows, measure],
  )
  const arrow = React.useId()
  const used = [...new Set(rows.map((row) => row.change))].filter((change) => change !== "same")
  const legend: LegendItem[] = used.map((change) => ({ key: change, label: MARK[change].word, swatch: cn("border-0", MARK[change].chip) }))

  const card = (row: BeforeAfterRow, side: BeforeAfterSide) => {
    const part = row[side]
    const at = layout.rows.get(row.id)![side]
    const look = part ? LOOK[row.change][side] : "empty"
    const place = { left: at.x + PAD, top: at.y + PAD, width: at.width, height: at.height }
    const box = cn("absolute flex flex-col justify-center gap-0.5 rounded-xl border-2 px-3 text-left", CARD_LOOK[look])
    if (!part) return <div key={`${row.id}-${side}`} aria-hidden="true" className={box} style={place} />
    const body = (
      <>
        <span className={cn("truncate nessa-text-4 font-semibold", look === "removed" && "line-through decoration-nessa-diff-deletion/70")}>{part.label}</span>
        {part.detail ? <span className="truncate font-mono nessa-text-2 text-muted-foreground">{part.detail}</span> : null}
      </>
    )
    const tip = [part.detail ?? part.label, row.note].filter(Boolean).join(" — ")
    return onSelect ? (
      <button key={`${row.id}-${side}`} type="button" title={tip} className={cn(box, CARD_BUTTON)} style={place} onClick={() => onSelect(row, side)}>
        {body}
      </button>
    ) : (
      <div key={`${row.id}-${side}`} title={tip} className={box} style={place}>
        {body}
      </div>
    )
  }

  const canvas = (
    <div className="relative" style={{ width: layout.width + PAD * 2, height: layout.height + PAD * 2 }}>
      {(["before", "after"] as const).map((side) => (
        <span key={side} className="absolute nessa-text-2 font-medium text-muted-foreground" style={{ left: layout.sides[side].x + PAD, top: PAD }}>
          {side === "before" ? beforeTitle : afterTitle}
        </span>
      ))}
      <svg aria-hidden="true" className="absolute inset-0 size-full overflow-visible">
        <Arrowheads id={arrow} />
        <g transform={`translate(${PAD} ${PAD})`}>
          {layout.flows.map((flow) => (
            <path key={flow.index} d={flow.path} strokeWidth={1.25} markerEnd={`url(#${arrow}-dim)`} className="fill-none stroke-muted-foreground/60" />
          ))}
        </g>
      </svg>
      {layout.flows.map((flow) => {
        const label = flows[flow.index]!.label
        return label ? (
          <span
            key={flow.index}
            title={label}
            className={cn("absolute -translate-y-1/2 whitespace-nowrap font-mono nessa-text-2 text-muted-foreground", flow.align === "end" && "-translate-x-full")}
            style={{ left: flow.label.x + PAD, top: flow.label.y + PAD }}
          >
            {shorten(label, LABEL_CHARS)}
          </span>
        ) : null
      })}
      {rows.map((row) => (
        <React.Fragment key={row.id}>
          {card(row, "before")}
          {card(row, "after")}
          <span
            title={[MARK[row.change].word, row.note].filter(Boolean).join(" — ")}
            className={cn("absolute flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full font-semibold leading-none", row.change === "same" ? "" : "size-6 nessa-text-3", MARK[row.change].chip)}
            style={{ left: layout.rows.get(row.id)!.marker.x + PAD, top: layout.rows.get(row.id)!.marker.y + PAD }}
          >
            {MARK[row.change].symbol}
          </span>
        </React.Fragment>
      ))}
    </div>
  )

  return (
    <DiagramFrame rootRef={root} slot="before-after" title={title ?? "Before and after"} legend={legend} caption={caption} canvas={canvas} refitKey={layout} expandLabel="Expand comparison" className={className} {...props} />
  )
}

export { BeforeAfter }
