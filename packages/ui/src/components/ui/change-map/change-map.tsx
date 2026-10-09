import * as React from "react"

import { cn } from "@/lib/utils"

import { Arrowheads, CARD_BUTTON, DiagramFrame, STATUS, shorten, statusItems, useMeasure, useWidth, type ChangeMapStatus } from "./diagram-parts"

import { gridColumns, layoutChangeMapGrid } from "./change-map-grid"
import { layoutChangeMap } from "./change-map-layout"

export type { ChangeMapStatus }

export interface ChangeMapNode {
  id: string
  /** The block's name — a class, a route, a table. */
  label: string
  /** A second line, typically the file it lives in. */
  detail?: string
  status: ChangeMapStatus
  /** A short marker in the card's corner — a finding id, a hunk count. */
  badge?: string
  /**
   * Richer content drawn in the card in place of `label` and `detail` — a summary, a file count.
   * `label` still names the card to assistive tech. Pair it with `cardSize` so there is room.
   */
  children?: React.ReactNode
}

export interface ChangeMapEdge {
  from: string
  to: string
  /** What travels along it — a call, a query, a request. */
  label?: string
}

export interface ChangeMapProps extends Omit<React.ComponentProps<"section">, "title" | "onSelect"> {
  nodes: readonly ChangeMapNode[]
  edges: readonly ChangeMapEdge[]
  title?: React.ReactNode
  /** A line under the map — where the edges came from, what a click does. */
  caption?: React.ReactNode
  /** The block shown as picked; its edges are drawn in full. */
  selectedId?: string
  /** Makes every block a button. Without it the map is a picture. */
  onSelect?: (node: ChangeMapNode) => void
  /** Every card at this size instead of sized to its name — for cards that carry `children`. */
  cardSize?: { width: number; height: number }
  /**
   * `flow` (the default) lays cards out left to right along the edges. `grid` keeps them in the
   * order given, wrapping across the width, with edges run through the gaps — for maps where
   * order matters more than flow, or where few cards are linked.
   */
  arrangement?: "flow" | "grid"
}

const SIZE = { nodeHeight: 60, columnGap: 72, rowGap: 32, labelHeight: 18 }
const PAD = 24
/** A grid card's width when the map is not given one, and the gap edges run through between cards. */
const GRID = { width: 240, gap: 48 }
/** A card grows with its name up to this, then truncates; never narrower than the floor. */
const CARD = { min: 150, max: 320, chrome: 36 }
/** Edge labels past this many characters are cut, with the whole text in their tooltip. */
const LABEL_CHARS = 36

/**
 * A change as the parts it touches: blocks laid out left to right along the calls between them,
 * coloured by whether each was added, modified, deleted or only affected. Cards size to their
 * names and gaps to their labels, so no label sits on a card. With `onSelect` each
 * block is a button — the place to open that block's diff. The map scrolls sideways when it is
 * wider than its column.
 */
function ChangeMap({ nodes, edges, title, caption, selectedId, onSelect, cardSize, arrangement = "flow", className, ...props }: ChangeMapProps) {
  // Cards and gaps are sized to their text, measured once the map has an element to read fonts from.
  const root = React.useRef<HTMLElement>(null)
  const measure = useMeasure(root)
  // A grid wraps to the width it is given, so it follows its column as that is resized.
  const across = useWidth(root, arrangement === "grid") - PAD * 2
  const grid = { width: cardSize?.width ?? GRID.width, height: cardSize?.height ?? SIZE.nodeHeight }
  const layout = React.useMemo(
    () =>
      arrangement === "grid"
        ? layoutChangeMapGrid({
            nodes,
            edges,
            columns: gridColumns({ count: nodes.length, width: across, cardWidth: grid.width, cardHeight: grid.height, gap: GRID.gap }),
            cardWidth: grid.width,
            cardHeight: grid.height,
            columnGap: GRID.gap,
            rowGap: GRID.gap,
          })
        : layoutChangeMap({
        ...SIZE,
        nodeHeight: cardSize?.height ?? SIZE.nodeHeight,
        nodes: nodes.map((node) => {
          if (cardSize) return { id: node.id, width: cardSize.width }
          const text = Math.max(measure(node.label, 14, "sans", 600), node.detail ? measure(node.detail, 12, "mono") : 0)
          return { id: node.id, width: Math.round(Math.min(CARD.max, Math.max(CARD.min, text + CARD.chrome))) }
        }),
        edges: edges.map((edge) => ({ from: edge.from, to: edge.to, labelWidth: edge.label ? Math.ceil(measure(shorten(edge.label, LABEL_CHARS), 12, "mono")) + 8 : undefined })),
      }),
    [nodes, edges, measure, cardSize, arrangement, across, grid.width, grid.height]
  )
  // Hovering a card lights its edges and dims the rest; otherwise the picked card's edges are drawn in full.
  const [hovered, setHovered] = React.useState<string>()
  const focus = hovered ?? selectedId
  const touches = (edge: ChangeMapEdge) => focus !== undefined && (edge.from === focus || edge.to === focus)
  const arrow = React.useId()

  // The drawing itself: shown in the card, and again in the viewer when expanded.
  const canvas = (
    <div className="relative" style={{ width: layout.width + PAD * 2, height: layout.height + PAD * 2 }}>
          <svg aria-hidden="true" className="absolute inset-0 size-full overflow-visible">
            <Arrowheads id={arrow} />
            <g transform={`translate(${PAD} ${PAD})`}>
              {layout.edges.map((edge) => {
                const lit = touches(edges[edge.index]!)
                return (
                  <path
                    key={edge.index}
                    d={edge.path}
                    strokeWidth={lit ? 2 : 1.25}
                    strokeDasharray={edge.back ? "4 3" : undefined}
                    markerEnd={`url(#${arrow}-${lit ? "lit" : "dim"})`}
                    className={cn("fill-none transition-[stroke,opacity]", lit ? "stroke-foreground" : "stroke-muted-foreground/50", hovered !== undefined && !lit && "opacity-30")}
                  />
                )
              })}
            </g>
          </svg>
          {layout.edges.map((edge) => {
            const label = edges[edge.index]!.label
            return label ? (
              <span
                key={edge.index}
                title={label.length > LABEL_CHARS ? label : undefined}
                className={cn("absolute -translate-x-1/2 -translate-y-1/2 rounded bg-card px-1 font-mono nessa-text-2 whitespace-nowrap", touches(edges[edge.index]!) ? "text-foreground" : "text-muted-foreground")}
                style={{ left: edge.label.x + PAD, top: edge.label.y + PAD }}
              >
                {shorten(label, LABEL_CHARS)}
              </span>
            ) : null
          })}
          {nodes.map((node) => {
            const at = layout.boxes.get(node.id)!
            const picked = node.id === selectedId
            const look = STATUS[node.status]
            const body = (
              <>
                {node.children ?? (
                  <>
                    <span className="truncate nessa-text-4 font-semibold">{node.label}</span>
                    {node.detail ? <span className="truncate font-mono nessa-text-2 text-muted-foreground">{node.detail}</span> : null}
                  </>
                )}
                {node.badge ? <span className="absolute -top-2.5 right-3 rounded-full bg-foreground px-1.5 py-px nessa-text-1 font-semibold text-background">{node.badge}</span> : null}
              </>
            )
            const box = cn(
              "absolute flex flex-col gap-0.5 rounded-xl border-2 px-3 text-left transition-[border-color,box-shadow]",
              node.children ? "justify-start py-3" : "justify-center",
              look.card,
              picked && cn(look.picked, "shadow-md ring-4 ring-ring/15")
            )
            const place = { left: at.x + PAD, top: at.y + PAD, width: at.width, height: at.height }
            const hover = { onPointerEnter: () => setHovered(node.id), onPointerLeave: () => setHovered(undefined) }
            return onSelect ? (
              <button key={node.id} type="button" aria-pressed={picked} aria-label={node.children ? node.label : undefined} {...hover} className={cn(box, CARD_BUTTON)} style={place} onClick={() => onSelect(node)}>
                {body}
              </button>
            ) : (
              <div key={node.id} className={box} style={place} aria-label={node.children ? node.label : undefined} {...hover}>
                {body}
              </div>
            )
          })}
        </div>
  )

  return (
    <DiagramFrame
      rootRef={root}
      slot="change-map"
      title={title ?? "Change map"}
      legend={statusItems(nodes.map((node) => node.status))}
      caption={caption}
      canvas={canvas}
      refitKey={layout}
      expandLabel="Expand map"
      className={className}
      {...props}
    />
  )
}

export { ChangeMap }
