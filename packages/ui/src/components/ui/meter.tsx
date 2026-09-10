import * as React from "react"

import { cn } from "@/lib/utils"

/** @responsibility Renders a decorative horizontal fraction meter with dotted and solid variants and fixed-slot series colors. */

/**
 * A categorical chart slot, `1` through `6`, selecting the same
 * `--nessa-chart-*` color the other chart primitives use. Give the meter
 * for series *i* the slot StackedBarChart would give it, and the two read
 * as one chart.
 */
export type MeterSlot = 1 | 2 | 3 | 4 | 5 | 6

export type MeterVariant = "dotted" | "solid"

export interface MeterProps
  extends Omit<React.ComponentProps<"span">, "children" | "slot"> {
  /**
   * The filled share of the track, `0` to `1`. Out-of-range values clamp —
   * an over-budget reading pins the meter full instead of painting outside
   * its box — and `NaN` renders empty; carry the raw number in the
   * adjacent text.
   */
  fraction: number
  /**
   * `"dotted"` (default) paints btop-style repeating dots; `"solid"` paints
   * a continuous rounded bar. Both keep the same footprint, so a panel can
   * mix them per row without misaligning columns.
   */
  variant?: MeterVariant
  /**
   * Categorical color slot for the filled portion, matching the
   * `--nessa-chart-1..6` palette by index. Omit it for the neutral
   * foreground ink — the right choice for a total row above per-series
   * meters.
   */
  slot?: MeterSlot
}

/**
 * The fill color per chart slot, injected as a custom property so one
 * track/fill recipe serves every slot. The mapping is fixed: slot `i`
 * always wears `--nessa-chart-i`, exactly like StackedBarChart's series
 * order, so a meter and a chart describing the same series agree.
 */
const meterSlotClasses = Object.freeze({
  1: "[--nessa-meter-fill:var(--nessa-chart-1)]",
  2: "[--nessa-meter-fill:var(--nessa-chart-2)]",
  3: "[--nessa-meter-fill:var(--nessa-chart-3)]",
  4: "[--nessa-meter-fill:var(--nessa-chart-4)]",
  5: "[--nessa-meter-fill:var(--nessa-chart-5)]",
  6: "[--nessa-meter-fill:var(--nessa-chart-6)]",
})

const neutralFillClass = "[--nessa-meter-fill:var(--foreground)]"

/**
 * A compact horizontal fraction meter in the console idiom: the filled
 * share paints in a categorical chart-slot color (or neutral foreground),
 * the remainder stays a recessive border-ink track. The dotted variant
 * repeats btop-style 3px dots; the solid variant is a continuous rounded
 * bar.
 *
 * Decorative by design and hidden from assistive technology — the meter
 * never carries text, so always pair it with the value it visualizes
 * ("42%", "1.2 GiB") in an adjacent element.
 *
 * @param props - Fraction, variant, and color slot plus host `span` props.
 * @returns An `aria-hidden` inline-block meter.
 */
function Meter({ className, fraction, variant = "dotted", slot, ...props }: MeterProps) {
  // NaN renders empty; ±Infinity clamp with everything else (Math.min and
  // Math.max pin them to the ends), so no input can paint outside the box.
  const clamped = Number.isNaN(fraction)
    ? 0
    : Math.min(1, Math.max(0, fraction))

  return (
    <span
      data-slot="meter"
      data-variant={variant}
      aria-hidden="true"
      className={cn(
        "relative inline-block h-1.75 w-full min-w-0 overflow-hidden",
        slot ? meterSlotClasses[slot] : neutralFillClass,
        className,
      )}
      {...props}
    >
      <span
        data-slot="meter-track"
        className={cn(
          "absolute inset-0",
          variant === "dotted"
            ? "bg-[repeating-linear-gradient(90deg,var(--border)_0_3px,transparent_3px_6px)]"
            : "rounded-full bg-border/60",
        )}
      />
      <span
        data-slot="meter-fill"
        className={cn(
          // In RTL the fill anchors to the inline start (visually right)
          // while the repeating gradient still runs left-to-right, so the
          // fill's dot phase can offset from the track's by up to half a
          // period — invisible at this dot size, and the meter is
          // decorative either way.
          "absolute inset-y-0 start-0",
          variant === "dotted"
            ? "bg-[repeating-linear-gradient(90deg,var(--nessa-meter-fill)_0_3px,transparent_3px_6px)]"
            : "rounded-full bg-(--nessa-meter-fill)",
        )}
        style={{ width: `${clamped * 100}%` }}
      />
    </span>
  )
}

export { Meter }
