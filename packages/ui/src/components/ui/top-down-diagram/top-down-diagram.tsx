import * as React from "react"

import { cn } from "@/lib/utils"

import { Arrowheads, CARD_BUTTON, DiagramFrame, STATUS, shorten, statusItems, useMeasure, type ChangeMapStatus, type Measure, type StatusLabels } from "../change-map/diagram-parts"
import { layoutTopDown } from "./top-down-layout"

type Size = { width: number; height: number }

/**
 * How a node draws — each diagram defines its own notation from these. The engine tints the
 * outline by the node's status and lays text inside it as `text` says.
 */
export interface TopDownShape {
  /** Outline classes: radius, border width and style. */
  outline: string
  /** The node's size, given its widest line of text measured in pixels and whether it has a detail line. */
  size: (text: number, detail: boolean) => Size
  /** `full` shows label and detail, `label` the label alone, centred; `none` neither. What is hidden becomes the tooltip. */
  text: "full" | "label" | "none"
  /** A fixed fill and border colour for a shape status does not tint — a bar, a circle. */
  look?: string
  /** Geometry for an outline that is not the node's box, such as a turned square. */
  style?: (box: Size) => React.CSSProperties
}

export interface TopDownNode {
  /** Unique within the diagram; edges, `roots` and `selectedId` refer to it. */
  id: string
  label: string
  /** A second line under the label; part of the tooltip on shapes that do not show it. */
  detail?: string
  /** Tints the node by how a change touches it; neutral when absent. */
  status?: ChangeMapStatus
  shape: TopDownShape
}

export interface TopDownEdge {
  from: string
  to: string
  label?: string
}

export interface TopDownDiagramProps extends Omit<React.ComponentProps<"section">, "title" | "onSelect"> {
  nodes: readonly TopDownNode[]
  edges: readonly TopDownEdge[]
  /** Where reading starts; the layout layers every node by its longest path from these. */
  roots?: readonly string[]
  title: React.ReactNode
  caption?: React.ReactNode
  /** Words for the legend's statuses in place of the built-in ones ("Added", "Modified", …); colours stay. */
  statusLabels?: StatusLabels
  /** The node shown as picked; its edges are drawn in full. */
  selectedId?: string
  /** Makes every node a button, called with the node's index. Without it the diagram is a picture. */
  onSelect?: (index: number) => void
  /** The section's `data-slot`. */
  slot: string
  expandLabel: string
  /** `bare` draws only the diagram at its natural size — no frame, header or scrolling — for hosts that frame it themselves (a canvas). */
  bare?: boolean
}

const SIZE = { rowGap: 40, columnGap: 28, labelHeight: 18 }
const PAD = 24
const LABEL_CHARS = 32
const NEUTRAL = { card: "border-border bg-card", picked: "border-foreground" }
/** A text shape's size: as wide as its text plus `chrome`, within `min` and `max`; taller with a detail line. */
export const fitText = (chrome: number, min = 120, max = 280) => (text: number, detail: boolean): Size => ({
  width: Math.round(Math.min(max, Math.max(min, text + chrome))),
  height: detail ? 56 : 42,
})

/** A shape whose size ignores its text — a bar, a circle. */
export const fixedSize = (width: number, height: number) => (): Size => ({ width, height })

const sizeOf = (node: TopDownNode, measure: Measure): Size =>
  node.shape.size(Math.max(measure(node.label, 14, "sans", 600), node.detail ? measure(node.detail, 12, "mono") : 0), Boolean(node.detail))

/**
 * The engine under the state machine and activity diagram: nodes of several shapes laid out top
 * to bottom along labelled edges (longest-path layers, back edges up lanes to the right), tinted
 * by status, with hover lighting a node's edges. With `onSelect` every node is a button.
 * Each node carries `data-node-id` so a host can find it.
 */
function TopDownDiagram({ nodes, edges, roots, title, caption, statusLabels, selectedId, onSelect, slot, expandLabel, className, ...props }: TopDownDiagramProps) {
  const root = React.useRef<HTMLElement>(null)
  const measure = useMeasure(root)
  const layout = React.useMemo(
    () =>
      layoutTopDown({
        ...SIZE,
        roots,
        nodes: nodes.map((node) => ({ id: node.id, ...sizeOf(node, measure) })),
        edges: edges.map((edge) => ({ from: edge.from, to: edge.to, labelWidth: edge.label ? Math.ceil(measure(shorten(edge.label, LABEL_CHARS), 12, "mono")) + 8 : undefined })),
      }),
    [nodes, edges, roots, measure],
  )
  // Hovering a node lights its edges and dims the rest; otherwise the picked node's edges are drawn in full.
  const [hovered, setHovered] = React.useState<string>()
  const focus = hovered ?? selectedId
  const touches = (edge: TopDownEdge) => focus !== undefined && (edge.from === focus || edge.to === focus)
  const arrow = React.useId()

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
      {nodes.map((node, index) => {
        const at = layout.boxes.get(node.id)!
        const picked = node.id === selectedId
        const shape = node.shape
        const tone = node.status ? STATUS[node.status] : NEUTRAL
        const outline = cn("absolute inset-0 transition-[border-color,box-shadow]", shape.look ?? tone.card, picked && cn(!shape.look && tone.picked, "shadow-md ring-4 ring-ring/15"), shape.outline)
        const body = (
          <>
            <span aria-hidden="true" className={outline} style={shape.style?.(at)} />
            {shape.text === "none" ? null : (
              <span className={cn("relative flex min-w-0 flex-col gap-0.5", shape.text === "label" ? "max-w-[60%] items-center text-center" : "w-full")}>
                <span className="truncate nessa-text-4 font-semibold">{node.label}</span>
                {node.detail && shape.text === "full" ? <span className="truncate font-mono nessa-text-2 text-muted-foreground">{node.detail}</span> : null}
              </span>
            )}
          </>
        )
        const common = {
          "data-node-id": node.id,
          // Whatever the shape does not show is its tooltip; a shape with no text is named by its label.
          title: shape.text === "full" ? undefined : [node.label, node.detail].filter(Boolean).join(" — "),
          "aria-label": shape.text === "none" ? node.label : undefined,
          className: cn("absolute flex items-center justify-center text-left", shape.text === "full" && "px-4"),
          style: { left: at.x + PAD, top: at.y + PAD, width: at.width, height: at.height },
          onPointerEnter: () => setHovered(node.id),
          onPointerLeave: () => setHovered(undefined),
          // Keyboard focus lights a node's edges just as the pointer does.
          onFocus: () => setHovered(node.id),
          onBlur: () => setHovered(undefined),
        }
        return onSelect ? (
          <button key={node.id} type="button" aria-pressed={picked} {...common} className={cn(common.className, CARD_BUTTON, "rounded-xl")} onClick={() => onSelect(index)}>
            {body}
          </button>
        ) : (
          <div key={node.id} role={shape.text === "none" ? "img" : undefined} {...common}>
            {body}
          </div>
        )
      })}
    </div>
  )

  return (
    <DiagramFrame
      rootRef={root}
      slot={slot}
      title={title}
      legend={statusItems(nodes.flatMap((node) => (node.status ? [node.status] : [])), statusLabels)}
      caption={caption}
      canvas={canvas}
      refitKey={layout}
      expandLabel={expandLabel}
      className={className}
      {...props}
    />
  )
}

export { TopDownDiagram }
