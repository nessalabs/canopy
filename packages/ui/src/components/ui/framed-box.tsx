"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/** @responsibility Renders a bordered console panel whose mono title (and optional right-side annotation) sits in the border line. */

export interface FramedBoxProps extends React.ComponentProps<"div"> {
  /**
   * The panel's name, set lowercase in the mono micro-size and cut into
   * the top border line — the btop console look. Also the box's accessible
   * name, so keep it meaningful ("cpu", "mem", "proc").
   */
  title: string
  /**
   * Optional annotation cut into the right end of the border line — the
   * place for a live aside like `up 14h` or `12 services`. Same mono
   * micro-type as the title, but casing is left alone.
   */
  annotation?: React.ReactNode
}

/**
 * A btop-style framed panel: a hairline border with the lowercase mono
 * title sitting in the border line, and an optional right-side annotation
 * cut into the same line. The box owns a card surface by default; the
 * title and annotation chips inherit whatever background the box has, so
 * overriding the surface (`className="bg-background"`) keeps the border
 * gaps clean — just keep it opaque, or the border shows through the chips.
 *
 * The box is a labelled group: assistive technology announces the title
 * when entering it, and the annotation reads as ordinary text after it.
 *
 * @param props - Title, annotation, and panel content plus host `div` props.
 * @returns A `role="group"` panel labelled by its in-border title.
 */
function FramedBox({
  className,
  title,
  annotation,
  children,
  ...props
}: FramedBoxProps) {
  const titleId = React.useId()

  return (
    <div
      data-slot="framed-box"
      role="group"
      aria-labelledby={titleId}
      className={cn(
        "relative rounded-md border border-border bg-card pt-3 text-card-foreground",
        className,
      )}
      {...props}
    >
      <span
        data-slot="framed-box-title"
        id={titleId}
        // The title and annotation share the border line; capping their
        // widths keeps a long pair from overlapping mid-frame, truncating
        // instead.
        className={cn(
          "absolute -top-2 start-3 truncate bg-inherit px-1 font-mono nessa-text-1 font-medium lowercase text-muted-foreground",
          annotation != null ? "max-w-[38%]" : "max-w-[calc(100%-1.5rem)]",
        )}
      >
        {title}
      </span>
      {annotation != null ? (
        <span
          data-slot="framed-box-annotation"
          className="absolute -top-2 end-3 max-w-[60%] truncate bg-inherit px-1 font-mono nessa-text-1 text-muted-foreground"
        >
          {annotation}
        </span>
      ) : null}
      {children}
    </div>
  )
}

export { FramedBox }
