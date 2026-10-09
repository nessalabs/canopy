import * as React from "react"

import { cn } from "@/lib/utils"

import { Arrowheads, CARD_BUTTON, DiagramFrame, STATUS, statusItems, type ChangeMapStatus } from "../change-map/diagram-parts"
import { layoutBlastRadius, type BlastRadiusColumn } from "./blast-radius-layout"

export interface BlastRadiusItem {
  id: string
  label: string
  /** A second line, typically the file it lives in. */
  detail?: string
  status: ChangeMapStatus
}

export interface BlastRadiusTest extends BlastRadiusItem {
  /** The changed parts this test exercises. */
  covers: readonly string[]
}

export interface BlastRadiusLink {
  from: string
  to: string
  /** What travels along it; shown on hover. */
  label?: string
}

export interface BlastRadiusProps extends Omit<React.ComponentProps<"section">, "title" | "onSelect"> {
  changed: readonly BlastRadiusItem[]
  /** What calls into the change. */
  upstream: readonly BlastRadiusItem[]
  /** What the change calls. */
  downstream: readonly BlastRadiusItem[]
  tests: readonly BlastRadiusTest[]
  links: readonly BlastRadiusLink[]
  title?: React.ReactNode
  caption?: React.ReactNode
  /** Makes every card a button — the place to open its code. */
  onSelect?: (item: BlastRadiusItem) => void
}

const SIZE = { cardWidth: 240, cardHeight: 58, columnGap: 56, rowGap: 28, maxRows: 5, headerHeight: 28 }
const PAD = 24
const COLUMN_NAME: Record<BlastRadiusColumn, string> = { upstream: "Callers", changed: "Changed", downstream: "Calls" }

/**
 * What a change can reach: the parts that call into it on the left, the changed parts in the
 * middle, what they call on the right, and the tests that cover them underneath. A changed part
 * no test covers says so. Hovering a card lights the edges that touch it.
 */
function BlastRadius({ changed, upstream, downstream, tests, links, title, caption, onSelect, className, ...props }: BlastRadiusProps) {
  const root = React.useRef<HTMLElement>(null)
  const covers = React.useMemo(() => tests.flatMap((test) => test.covers.map((target) => ({ test: test.id, target }))), [tests])
  const layout = React.useMemo(
    () =>
      layoutBlastRadius({
        ...SIZE,
        upstream: upstream.map((item) => item.id),
        changed: changed.map((item) => item.id),
        downstream: downstream.map((item) => item.id),
        tests: tests.map((test) => test.id),
        links,
        covers,
      }),
    [upstream, changed, downstream, tests, links, covers],
  )
  const covered = new Set(covers.map((cover) => cover.target))
  const [hovered, setHovered] = React.useState<string>()
  const arrow = React.useId()
  const items = [...upstream, ...changed, ...downstream, ...tests]
  const changedIds = new Set(changed.map((item) => item.id))
  const touches = (from: string, to: string) => hovered !== undefined && (from === hovered || to === hovered)
  const changedColumn = layout.columns.find((column) => column.key === "changed")

  const canvas = (
    <div className="relative" style={{ width: layout.width + PAD * 2, height: layout.height + PAD * 2 }}>
      {changedColumn ? (
        <div
          aria-hidden="true"
          className="absolute rounded-2xl bg-muted/50"
          style={{ left: changedColumn.x + PAD - 12, top: PAD - 4, width: changedColumn.width + 24, height: layout.gridBottom + 16 }}
        />
      ) : null}
      {layout.columns.map((column) => (
        <span key={column.key} className="absolute nessa-text-2 font-medium text-muted-foreground" style={{ left: column.x + PAD, top: PAD }}>
          {COLUMN_NAME[column.key]}
        </span>
      ))}
      {tests.length > 0 ? (
        <span className="absolute nessa-text-2 font-medium text-muted-foreground" style={{ left: PAD, top: layout.testsTop - SIZE.headerHeight + PAD }}>
          Tests
        </span>
      ) : null}
      <svg aria-hidden="true" className="absolute inset-0 size-full overflow-visible">
        <Arrowheads id={arrow} />
        <g transform={`translate(${PAD} ${PAD})`}>
          {layout.edges.map((edge) => {
            const link = edge.kind === "link" ? links[edge.index]! : undefined
            const cover = edge.kind === "covers" ? covers[edge.index]! : undefined
            const [from, to] = link ? [link.from, link.to] : [cover!.test, cover!.target]
            const lit = touches(from, to)
            return (
              <path
                key={`${edge.kind}-${edge.index}`}
                d={edge.path}
                strokeWidth={lit ? 2 : 1.25}
                strokeDasharray={edge.kind === "covers" ? "3 3" : undefined}
                markerEnd={`url(#${arrow}-${lit ? "lit" : "dim"})`}
                className={cn("fill-none transition-[stroke,opacity]", lit ? "stroke-foreground" : "stroke-muted-foreground/50", hovered !== undefined && !lit && "opacity-25")}
              >
                {link?.label ? <title>{link.label}</title> : null}
              </path>
            )
          })}
        </g>
      </svg>
      {items.map((item) => {
        const at = layout.boxes.get(item.id)
        if (!at) return null
        const untested = changedIds.has(item.id) && !covered.has(item.id)
        const body = (
          <>
            <span className="truncate nessa-text-4 font-semibold">{item.label}</span>
            {item.detail ? <span className="truncate font-mono nessa-text-2 text-muted-foreground">{item.detail}</span> : null}
            {untested ? (
              <span className="absolute -top-2.5 right-3 rounded-full bg-nessa-diff-deletion px-1.5 py-px nessa-text-1 font-semibold text-background">untested</span>
            ) : null}
          </>
        )
        const box = cn("absolute flex flex-col justify-center gap-0.5 rounded-xl border-2 px-3 text-left transition-shadow", STATUS[item.status].card, changedIds.has(item.id) && "shadow-sm")
        const place = { left: at.x + PAD, top: at.y + PAD, width: at.width, height: at.height }
        const hover = { onPointerEnter: () => setHovered(item.id), onPointerLeave: () => setHovered(undefined) }
        return onSelect ? (
          <button key={item.id} type="button" title={item.detail ?? item.label} className={cn(box, CARD_BUTTON)} style={place} onClick={() => onSelect(item)} {...hover}>
            {body}
          </button>
        ) : (
          <div key={item.id} title={item.detail ?? item.label} className={box} style={place} {...hover}>
            {body}
          </div>
        )
      })}
    </div>
  )

  const untestedCount = changed.filter((item) => !covered.has(item.id)).length
  return (
    <DiagramFrame
      rootRef={root}
      slot="blast-radius"
      title={title ?? "Blast radius"}
      legend={[
        ...statusItems(items.map((item) => item.status)),
        ...(untestedCount > 0 ? [{ key: "untested", label: "No test covers it", swatch: "border-0 bg-nessa-diff-deletion" }] : []),
      ]}
      caption={caption}
      canvas={canvas}
      refitKey={layout}
      expandLabel="Expand blast radius"
      className={className}
      {...props}
    />
  )
}

export { BlastRadius }
