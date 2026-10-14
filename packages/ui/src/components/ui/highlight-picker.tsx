import * as React from "react"
import { Eraser, Plus } from "lucide-react"

import { cn } from "@/lib/utils"

/** One highlighter colour: a stable id, its accessible name, and any CSS colour. */
export interface HighlightSwatch {
  id: string
  label: string
  color: string
}

/**
 * Nessa's highlighter palette, drawn from the `--nessa-highlight-*` tokens.
 * The first three are the everyday pens; the rest are what "+" offers.
 */
export const HIGHLIGHT_SWATCHES: readonly HighlightSwatch[] = Object.freeze([
  { id: "yellow", label: "Yellow", color: "var(--nessa-highlight-yellow)" },
  { id: "green", label: "Green", color: "var(--nessa-highlight-green)" },
  { id: "pink", label: "Pink", color: "var(--nessa-highlight-pink)" },
  { id: "orange", label: "Orange", color: "var(--nessa-highlight-orange)" },
  { id: "blue", label: "Blue", color: "var(--nessa-highlight-blue)" },
  { id: "purple", label: "Purple", color: "var(--nessa-highlight-purple)" },
])

export interface HighlightPickerProps
  extends Omit<React.ComponentProps<"div">, "onClick"> {
  /** The pens on the rail; the first is the lead, applied by a single click. */
  colors: readonly HighlightSwatch[]
  /** Colours "+" offers to add to the rail. Omit (or pass none) to hide "+". */
  more?: readonly HighlightSwatch[]
  /** Applies a pen from the rail. */
  onPick: (swatch: HighlightSwatch) => void
  /** Adds one of `more` to the rail; the host decides whether it is also applied. */
  onAdd?: (swatch: HighlightSwatch) => void
  /** Shows an eraser at the end of the rail, for when the target is already highlighted. */
  onClear?: () => void
}

const SLOT = cn(
  "inline-flex size-8 shrink-0 items-center justify-center rounded-lg border-0 bg-transparent p-0 text-popover-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:[outline-style:solid] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&_svg]:size-4 [&_svg]:shrink-0",
)

/** The swatch buttons' dot grows a touch under the pointer. */
const SWATCH = cn(SLOT, "hover:[&>span]:scale-115")

const EASE = "duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none"

function Dot({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      data-slot="highlight-picker-dot"
      className="size-3.5 rounded-full bg-(--nessa-highlight-swatch) shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--foreground)_18%,transparent)] transition-[scale]"
      style={{ "--nessa-highlight-swatch": color } as React.CSSProperties}
    />
  )
}

/**
 * A run of picker items that slides open from zero width: the grid track
 * animates, and each item grows in just after the one before it. Closing is
 * immediate — only opening is staggered. Closed and `inert`, nothing in it
 * takes focus.
 */
function Drawer({
  open,
  opensOnFocus = false,
  inert,
  slot,
  children,
}: {
  open: boolean
  /** Also open while anything in the picker has keyboard focus. */
  opensOnFocus?: boolean
  inert?: boolean
  slot: string
  children: React.ReactNode
}) {
  return (
    <div
      data-slot={slot}
      data-open={open ? "true" : "false"}
      inert={inert}
      className={cn(
        "group/drawer grid grid-cols-[0fr] transition-[grid-template-columns] data-[open=true]:grid-cols-[1fr]",
        opensOnFocus &&
          "group-has-[:focus-visible]/highlight-picker:grid-cols-[1fr]",
        EASE,
      )}
    >
      <div className="flex min-w-0 items-center overflow-hidden">
        {React.Children.map(children, (child, index) => (
          <span
            className={cn(
              "flex scale-50 opacity-0 transition-[scale,opacity] group-data-[open=true]/drawer:scale-100 group-data-[open=true]/drawer:opacity-100 group-data-[open=true]/drawer:delay-[calc(var(--nessa-stagger-index)*35ms)]",
              opensOnFocus &&
                "group-has-[:focus-visible]/highlight-picker:scale-100 group-has-[:focus-visible]/highlight-picker:opacity-100",
              EASE,
            )}
            style={{ "--nessa-stagger-index": index } as React.CSSProperties}
          >
            {child}
          </span>
        ))}
      </div>
    </div>
  )
}

/**
 * A highlighter pen for a selection callout. Only the lead colour shows at
 * rest — one click highlights with it. Hovering or focusing the picker fans
 * the other pens out beside it, each growing in just after the last, with "+"
 * at the end; "+" turns into a close and slides out a second run of colours
 * to add. Hosts own what a highlight is: the picker only reports the pen
 * chosen, a colour added, or a clear. Built to sit inside a SelectionTooltip,
 * where the pill grows with the rail.
 */
function HighlightPicker({
  colors,
  more = [],
  onPick,
  onAdd,
  onClear,
  className,
  "aria-label": ariaLabel = "Highlight",
  ...props
}: HighlightPickerProps) {
  const [hovered, setHovered] = React.useState(false)
  const [adding, setAdding] = React.useState(false)
  const [lead, ...rest] = colors
  if (lead === undefined) return null
  const canAdd = onAdd !== undefined && more.length > 0
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      data-slot="highlight-picker"
      className={cn("group/highlight-picker flex items-center", className)}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => {
        setHovered(false)
        setAdding(false)
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setAdding(false)
      }}
      {...props}
    >
      <button
        type="button"
        aria-label={`Highlight ${lead.label.toLowerCase()}`}
        data-slot="highlight-picker-lead"
        className={SWATCH}
        onClick={() => onPick(lead)}
      >
        <Dot color={lead.color} />
      </button>
      {/* Keyboard focus opens the rail as hover does — through CSS, so it can never
          outlive the focus. A click's focus is not :focus-visible, so the rail
          still closes once the pointer leaves. */}
      <Drawer
        open={hovered || adding}
        opensOnFocus
        slot="highlight-picker-rail"
      >
        {rest.map((swatch) => (
          <button
            key={swatch.id}
            type="button"
            aria-label={`Highlight ${swatch.label.toLowerCase()}`}
            data-slot="highlight-picker-swatch"
            className={SWATCH}
            onClick={() => onPick(swatch)}
          >
            <Dot color={swatch.color} />
          </button>
        ))}
        {canAdd && (
          <button
            type="button"
            aria-label={adding ? "Close more colours" : "More colours"}
            aria-expanded={adding}
            data-slot="highlight-picker-add"
            className={cn(
              SLOT,
              "text-muted-foreground [&_svg]:transition-transform aria-expanded:[&_svg]:rotate-45",
            )}
            onClick={() => setAdding(!adding)}
          >
            <Plus aria-hidden="true" />
          </button>
        )}
        {onClear && (
          <button
            type="button"
            aria-label="Remove highlight"
            data-slot="highlight-picker-clear"
            className={SLOT}
            onClick={onClear}
          >
            <Eraser aria-hidden="true" />
          </button>
        )}
      </Drawer>
      {canAdd && (
        <Drawer open={adding} inert={!adding} slot="highlight-picker-more">
          {more.map((swatch) => (
            <button
              key={swatch.id}
              type="button"
              aria-label={`Add ${swatch.label.toLowerCase()}`}
              data-slot="highlight-picker-more-swatch"
              className={SWATCH}
              onClick={() => {
                setAdding(false)
                onAdd(swatch)
              }}
            >
              <Dot color={swatch.color} />
            </button>
          ))}
        </Drawer>
      )}
    </div>
  )
}

export { HighlightPicker }
