import * as React from "react"

import { cn } from "@/lib/utils"

/** @responsibility Renders a hairline-boxed data cell: an uppercase micro-label over a mono value with an optional hint line and semantic tone. */

export interface StatTileProps
  extends Omit<React.ComponentProps<"div">, "children"> {
  /**
   * The micro-label above the value. Rendered uppercase with wide tracking;
   * pass it in natural casing ("Databases", not "DATABASES") so assistive
   * technology is not read a shouted acronym.
   */
  label: React.ReactNode
  /**
   * The fact itself, set in mono with tabular numerals. Text truncates with
   * an ellipsis rather than wrapping, so the tile keeps one fixed height in
   * a grid of tiles.
   */
  value: React.ReactNode
  /** Optional fine-print line under the value ("from prod-replica"). */
  hint?: React.ReactNode
  /**
   * Semantic ink for the value: `"ok"` paints it in the diff-addition
   * green, `"warn"` in the destructive red. Omit it for the default
   * foreground ink — most tiles are neutral facts, and a wall of colored
   * values stops reading as signal.
   */
  tone?: StatTileTone
}

/** Semantic ink for a StatTile's value: healthy green or destructive red. */
export type StatTileTone = "ok" | "warn"

/**
 * The console's signature data cell: an uppercase micro-label over a mono
 * value inside a hairline box, with an optional hint line and an optional
 * semantic tone on the value. Built for dense fact grids — fleet totals on
 * a command center, per-database facts on a dashboard.
 *
 * Purely presentational: the tile renders its content as plain text in
 * document order (label, value, hint), so it needs no ARIA wiring.
 *
 * @param props - Tile content plus host `div` props.
 * @returns A bordered tile displaying the labelled value.
 */
function StatTile({ className, label, value, hint, tone, ...props }: StatTileProps) {
  return (
    <div
      data-slot="stat-tile"
      data-tone={tone}
      className={cn(
        "flex min-w-0 flex-col gap-0.5 rounded-lg border border-border bg-muted/30 px-3 py-2",
        className,
      )}
      {...props}
    >
      <span
        data-slot="stat-tile-label"
        className="truncate nessa-text-1 font-medium tracking-[0.12em] text-muted-foreground uppercase"
      >
        {label}
      </span>
      <span
        data-slot="stat-tile-value"
        className={cn(
          "truncate font-mono nessa-text-4 font-medium tabular-nums",
          tone === "ok" && "text-(--nessa-diff-addition)",
          tone === "warn" && "text-destructive",
        )}
      >
        {value}
      </span>
      {hint != null ? (
        <span
          data-slot="stat-tile-hint"
          className="truncate nessa-text-1 text-muted-foreground"
        >
          {hint}
        </span>
      ) : null}
    </div>
  )
}

export { StatTile }
