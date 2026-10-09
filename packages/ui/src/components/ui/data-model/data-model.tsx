import * as React from "react"

import { cn } from "@/lib/utils"

import { Arrowheads, CARD_BUTTON, DiagramFrame, STATUS, shorten, statusItems, useWidth, type ChangeMapStatus, type LegendItem } from "../change-map/diagram-parts"
import { ENTITY_ROWS, layoutDataModel } from "./data-model-layout"

export interface DataModelField {
  name: string
  type?: string
  change?: "added" | "removed" | "changed"
  key?: "primary" | "foreign"
  /** Shown on hover — what changed about it, what it holds. */
  note?: string
}

export interface DataModelEntity {
  id: string
  /** A table, a type, a schema. */
  label: string
  /** A second line, typically the file or migration it lives in. */
  detail?: string
  status: ChangeMapStatus
  fields: readonly DataModelField[]
}

export interface DataModelRelation {
  from: string
  to: string
  label?: string
  /** `1..n`, `0..1` — drawn beside the label. */
  cardinality?: string
}

export interface DataModelProps extends Omit<React.ComponentProps<"section">, "title"> {
  entities: readonly DataModelEntity[]
  relations: readonly DataModelRelation[]
  title?: React.ReactNode
  caption?: React.ReactNode
  /** Makes every card a button — the place to open its definition. */
  onSelectEntity?: (entity: DataModelEntity) => void
}

const CARD_WIDTH = 260
const GAP = 56
const PAD = 24
const LABEL_CHARS = 24

const FIELD_LOOK: Record<NonNullable<DataModelField["change"]>, { row: string; mark: string; word: string }> = {
  added: { row: "bg-nessa-diff-addition/10 text-foreground", mark: "+", word: "Added field" },
  changed: { row: "bg-nessa-diff-modification/10 text-foreground", mark: "~", word: "Changed field" },
  removed: { row: "text-muted-foreground line-through decoration-nessa-diff-deletion/70", mark: "−", word: "Removed field" },
}
const MARK_TONE = { added: "text-nessa-diff-addition", changed: "text-nessa-diff-modification", removed: "text-nessa-diff-deletion" } as const

/**
 * The tables and types a change touches, as cards in a grid that reads across and down: each
 * lists its fields with their types, new fields tinted, changed ones marked, removed ones struck
 * through, keys flagged. Relations run along the gaps between cards, labelled with their
 * cardinality; hovering a card lights its relations.
 */
function DataModel({ entities, relations, title, caption, onSelectEntity, className, ...props }: DataModelProps) {
  const root = React.useRef<HTMLElement>(null)
  const width = useWidth(root) - PAD * 2
  const layout = React.useMemo(
    () => layoutDataModel({ entities: entities.map((entity) => ({ id: entity.id, fields: entity.fields.length })), relations, width, cardWidth: CARD_WIDTH, gap: GAP }),
    [entities, relations, width],
  )
  const [hovered, setHovered] = React.useState<string>()
  const arrow = React.useId()
  const touches = (relation: DataModelRelation) => hovered !== undefined && (relation.from === hovered || relation.to === hovered)
  const changes = new Set(entities.flatMap((entity) => entity.fields.flatMap((field) => (field.change ? [field.change] : []))))
  const legend: LegendItem[] = [
    ...statusItems(entities.map((entity) => entity.status)),
    ...(["added", "changed", "removed"] as const).filter((change) => changes.has(change)).map((change) => ({ key: `field-${change}`, label: FIELD_LOOK[change].word, swatch: cn("border-0", change === "removed" ? "bg-nessa-diff-deletion/40" : change === "added" ? "bg-nessa-diff-addition/40" : "bg-nessa-diff-modification/40") })),
  ]

  const canvas = (
    <div className="relative" style={{ width: layout.width + PAD * 2, height: layout.height + PAD * 2 }}>
      <svg aria-hidden="true" className="absolute inset-0 size-full overflow-visible">
        <Arrowheads id={arrow} />
        <g transform={`translate(${PAD} ${PAD})`}>
          {layout.edges.map((edge) => {
            const lit = touches(relations[edge.index]!)
            return (
              <path
                key={edge.index}
                d={edge.path}
                strokeWidth={lit ? 2 : 1.25}
                strokeDasharray={edge.back ? "4 3" : undefined}
                markerEnd={`url(#${arrow}-${lit ? "lit" : "dim"})`}
                className={cn("fill-none transition-[stroke,opacity]", lit ? "stroke-foreground" : "stroke-muted-foreground/50", hovered !== undefined && !lit && "opacity-25")}
              />
            )
          })}
        </g>
      </svg>
      {layout.edges.map((edge) => {
        const relation = relations[edge.index]!
        const text = [relation.cardinality, relation.label].filter(Boolean).join(" ")
        if (!text) return null
        return (
          <span
            key={edge.index}
            title={text}
            className={cn("absolute -translate-y-full whitespace-nowrap rounded bg-card px-1 font-mono nessa-text-2", touches(relation) ? "text-foreground" : "text-muted-foreground", hovered !== undefined && !touches(relation) && "opacity-40")}
            // Just right of the turn into the target, above the line.
            style={{ left: edge.label.x + PAD + 6, top: edge.label.y + PAD - 2 }}
          >
            {shorten(text, LABEL_CHARS)}
          </span>
        )
      })}
      {entities.map((entity) => {
        const at = layout.boxes.get(entity.id)
        if (!at) return null
        const body = (
          <>
            <span className="flex shrink-0 flex-col justify-center gap-0.5 px-3" style={{ height: ENTITY_ROWS.header - 8 }}>
              <span className="truncate nessa-text-4 font-semibold">{entity.label}</span>
              {entity.detail ? <span className="truncate font-mono nessa-text-2 text-muted-foreground">{entity.detail}</span> : null}
            </span>
            <span className="mx-3 mb-1 shrink-0 border-t border-current opacity-15" />
            {entity.fields.map((field) => {
              const look = field.change ? FIELD_LOOK[field.change] : undefined
              return (
                <span
                  key={field.name}
                  title={[field.change ? look!.word : undefined, field.note].filter(Boolean).join(" — ") || undefined}
                  className={cn("mx-1.5 flex items-center gap-2 rounded px-1.5 font-mono nessa-text-2", look?.row)}
                  style={{ height: ENTITY_ROWS.field }}
                >
                  <span className={cn("w-3 shrink-0 text-center font-semibold no-underline", field.change && MARK_TONE[field.change])}>{look?.mark ?? ""}</span>
                  <span className="min-w-0 flex-1 truncate">{field.name}</span>
                  {field.key ? <span className="shrink-0 rounded border border-current px-1 nessa-text-1 opacity-60">{field.key === "primary" ? "PK" : "FK"}</span> : null}
                  {field.type ? <span className="max-w-[45%] shrink-0 truncate text-muted-foreground">{field.type}</span> : null}
                </span>
              )
            })}
          </>
        )
        const box = cn("absolute flex flex-col overflow-hidden rounded-xl border-2 text-left", STATUS[entity.status].card)
        const place = { left: at.x + PAD, top: at.y + PAD, width: at.width, height: at.height }
        const hover = { onPointerEnter: () => setHovered(entity.id), onPointerLeave: () => setHovered(undefined) }
        return onSelectEntity ? (
          <button key={entity.id} type="button" aria-label={entity.label} className={cn(box, CARD_BUTTON)} style={place} onClick={() => onSelectEntity(entity)} {...hover}>
            {body}
          </button>
        ) : (
          <div key={entity.id} aria-label={entity.label} className={box} style={place} {...hover}>
            {body}
          </div>
        )
      })}
    </div>
  )

  return (
    <DiagramFrame rootRef={root} slot="data-model" title={title ?? "Data model"} legend={legend} caption={caption} canvas={canvas} refitKey={layout} expandLabel="Expand data model" className={className} {...props} />
  )
}

export { DataModel }
