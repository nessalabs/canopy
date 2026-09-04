import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * A multi-line text field styled to match Input exactly — the same hairline
 * field border, invalid (`aria-invalid`) and disabled states, and focus
 * treatment — so single-line and multi-line entry read as one family in a
 * form. The field grows with its content from a four-line minimum
 * (`field-sizing-content`); cap it with a `max-h-*` class when the host
 * needs a ceiling.
 */
function Textarea({
  className,
  ...props
}: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex box-border field-sizing-content min-h-16 w-full min-w-0 appearance-none rounded-md border border-input bg-transparent px-3 py-2 font-sans nessa-text-input text-foreground shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40",
        "aria-invalid:border-destructive aria-invalid:ring-(--nessa-invalid-ring)",
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }
