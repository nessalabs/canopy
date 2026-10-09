import { gridColumns, layoutChangeMapGrid } from "../change-map/change-map-grid"
import type { ChangeMapLayout } from "../change-map/change-map-layout"

export interface DataModelLayoutInput {
  /** Each entity, with how many field rows it shows. */
  entities: readonly { id: string; fields: number }[]
  relations: readonly { from: string; to: string }[]
  /** The width the grid may fill; it wraps to as many columns as fit, never fewer than a balanced shape needs. */
  width: number
  cardWidth: number
  gap: number
}

/** A card's header, each field's row, and the padding under the last field. */
export const ENTITY_ROWS = { header: 58, field: 24, foot: 10 }

export const entityHeight = (fields: number): number => ENTITY_ROWS.header + fields * ENTITY_ROWS.field + ENTITY_ROWS.foot

/**
 * Entities in a wrapping grid, each card as tall as its fields, every row as tall as its tallest
 * card, with relations routed along the gaps — so a model of a dozen types reads across and
 * down rather than as one long list.
 */
const average = (values: readonly number[]): number => (values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length)

export function layoutDataModel({ entities, relations, width, cardWidth, gap }: DataModelLayoutInput): ChangeMapLayout {
  return layoutChangeMapGrid({
    nodes: entities.map((entity) => ({ id: entity.id, height: entityHeight(entity.fields) })),
    edges: relations,
    columns: gridColumns({ count: entities.length, width, cardWidth, cardHeight: average(entities.map((entity) => entityHeight(entity.fields))), gap }),
    cardWidth,
    cardHeight: entityHeight(0),
    columnGap: gap,
    rowGap: gap,
  })
}
