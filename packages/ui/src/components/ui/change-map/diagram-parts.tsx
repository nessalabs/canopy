import * as React from "react"
import { Maximize2 } from "lucide-react"

import { cn } from "@/lib/utils"

import { useDiagramViewer } from "../diagram-viewer"

/**
 * The pieces every change diagram shares — the change map, call flow, blast radius, before/after
 * and data model: one colour per kind of change, the legend that names them, text measured in
 * the theme's own fonts, and the framed card with its title, legend, expand control and caption.
 */

/** How a part took part in the change. */
export type ChangeMapStatus = "added" | "modified" | "deleted" | "affected" | "external"

export const STATUS: Record<ChangeMapStatus, { label: string; card: string; picked: string }> = {
  added: { label: "Added", card: "border-nessa-diff-addition/60 bg-nessa-diff-addition/10", picked: "border-nessa-diff-addition" },
  modified: { label: "Modified", card: "border-nessa-diff-modification/60 bg-nessa-diff-modification/10", picked: "border-nessa-diff-modification" },
  deleted: { label: "Deleted", card: "border-nessa-diff-deletion/60 bg-nessa-diff-deletion/10", picked: "border-nessa-diff-deletion" },
  affected: { label: "Unchanged, affected", card: "border-dashed border-muted-foreground/50 bg-card", picked: "border-solid border-foreground" },
  external: { label: "External", card: "border-border bg-muted/60 text-muted-foreground", picked: "border-foreground" },
}

export const STATUS_ORDER: readonly ChangeMapStatus[] = ["added", "modified", "deleted", "affected", "external"]

/** A line's tint for a change that is not a card: an arrow, a field, a marker. */
export const CHANGE_TEXT = {
  added: "text-nessa-diff-addition",
  modified: "text-nessa-diff-modification",
  changed: "text-nessa-diff-modification",
  deleted: "text-nessa-diff-deletion",
  removed: "text-nessa-diff-deletion",
} as const

export interface LegendItem {
  key: string
  label: string
  /** Classes for the swatch: a border and fill, or a stroke colour. */
  swatch: string
}

/** The legend items for the statuses a diagram actually uses, in a fixed order. */
export const statusItems = (used: Iterable<ChangeMapStatus>): LegendItem[] => {
  const set = new Set(used)
  return STATUS_ORDER.filter((status) => set.has(status)).map((status) => ({ key: status, label: STATUS[status].label, swatch: STATUS[status].card }))
}

export function Legend({ items }: { items: readonly LegendItem[] }) {
  if (items.length === 0) return null
  return (
    <ul data-slot="change-map-legend" className="flex flex-wrap items-center gap-x-4 gap-y-1 nessa-text-2 text-muted-foreground">
      {items.map((item) => (
        <li key={item.key} className="flex items-center gap-1.5">
          <span aria-hidden="true" className={cn("size-3 rounded-sm border-2", item.swatch)} />
          {item.label}
        </li>
      ))}
    </ul>
  )
}

/** Measures text in the theme's own font families, read from the element the diagram renders in. */
export type Measure = (text: string, size: number, family: "sans" | "mono", weight?: number) => number

/** Before the diagram is on screen there is nothing to read fonts from; an average glyph width stands in. */
export const estimate: Measure = (text, size, family) => text.length * size * (family === "mono" ? 0.62 : 0.56)

function measurerFor(element: HTMLElement): Measure {
  const context = element.ownerDocument.createElement("canvas").getContext("2d")
  if (!context) return estimate
  const style = getComputedStyle(element)
  const stack = (family: "sans" | "mono") => style.getPropertyValue(`--nessa-font-${family}`).trim() || family
  return (text, size, family, weight = 400) => {
    context.font = `${weight} ${size}px ${stack(family)}`
    return context.measureText(text).width
  }
}

/** A measurer for text drawn inside `root`, exact once the element is mounted. */
export function useMeasure(root: React.RefObject<HTMLElement | null>): Measure {
  const [measure, setMeasure] = React.useState<Measure>(() => estimate)
  React.useLayoutEffect(() => {
    if (root.current) setMeasure(() => measurerFor(root.current!))
  }, [root])
  return measure
}

/** The inner width of `root`, followed as it is resized; 0 until measured or when not `enabled`. */
export function useWidth(root: React.RefObject<HTMLElement | null>, enabled = true): number {
  const [width, setWidth] = React.useState(0)
  React.useLayoutEffect(() => {
    if (!enabled || !root.current) return
    const element = root.current
    const update = () => setWidth(element.clientWidth)
    update()
    // Without ResizeObserver (a test DOM, an old runtime) the first measure stands.
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [enabled, root])
  return width
}

/** Text past `max` characters cut with an ellipsis; give the whole text as a `title`. */
export const shorten = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** Arrowheads for a diagram's edges: `${id}-dim` for resting edges, `${id}-lit` for those in focus, `${id}-open` for async ones. */
export function Arrowheads({ id }: { id: string }) {
  return (
    <defs>
      {(["dim", "lit"] as const).map((tone) => (
        <marker key={tone} id={`${id}-${tone}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 8 4 L 0 8 z" className={tone === "lit" ? "fill-foreground" : "fill-muted-foreground/60"} />
        </marker>
      ))}
      <marker id={`${id}-open`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
        <path d="M 0.5 0.5 L 7.5 4 L 0.5 7.5" className="fill-none stroke-muted-foreground" strokeWidth="1.25" />
      </marker>
    </defs>
  )
}

export interface DiagramFrameProps extends Omit<React.ComponentProps<"section">, "title" | "children"> {
  /** The section element; diagrams measure text and width inside it. */
  rootRef: React.RefObject<HTMLElement | null>
  slot: string
  title: React.ReactNode
  legend?: readonly LegendItem[]
  caption?: React.ReactNode
  /** The drawing, shown in the card and again, full screen, when expanded. */
  canvas: React.ReactNode
  /** Changes when the drawing does, so an open viewer refits. */
  refitKey?: unknown
  /** What the expand control is called, e.g. "Expand map". */
  expandLabel?: string
}

/**
 * The card every change diagram sits in: a header with its title, legend and an expand control
 * that opens the drawing in the full-screen viewer, the drawing itself (scrolling sideways when
 * wider than its column), and an optional caption.
 */
export function DiagramFrame({ rootRef, slot, title, legend = [], caption, canvas, refitKey, expandLabel = "Expand diagram", className, ...props }: DiagramFrameProps) {
  const { viewer, expand } = useDiagramViewer(rootRef)
  return (
    <section
      ref={rootRef as React.RefObject<HTMLElement>}
      data-slot={slot}
      className={cn("flex flex-col overflow-hidden rounded-2xl border border-border bg-card text-card-foreground", className)}
      {...props}
    >
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-4 py-3">
        <h3 className="nessa-text-4 font-semibold">{title}</h3>
        <div className="flex items-center gap-3">
          <Legend items={legend} />
          <button
            type="button"
            aria-label={expandLabel}
            title={expandLabel}
            onClick={expand}
            className="flex size-7 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&_svg]:size-3.5"
          >
            <Maximize2 aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="overflow-x-auto">{canvas}</div>
      {caption ? <p className="border-t border-border px-4 py-2.5 nessa-text-2 text-muted-foreground">{caption}</p> : null}
      {viewer(<div className="rounded-2xl bg-card text-card-foreground">{canvas}</div>, { refitKey })}
    </section>
  )
}

/** Classes for a card that is a button: pointer, hover lift, a visible keyboard focus. */
export const CARD_BUTTON = "cursor-pointer hover:shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
