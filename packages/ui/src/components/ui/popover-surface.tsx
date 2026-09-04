import * as React from "react"
import { Slot } from "radix-ui"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * The floating-surface recipe shared by Nessa's overlay chrome: popover
 * tokens over a hairline border. Exported — like `buttonVariants` — so
 * primitives that render through other libraries' content components can
 * reuse the exact classes.
 */
const popoverSurfaceVariants = cva(
  "border border-border bg-popover font-sans text-popover-foreground",
  {
    variants: {
      elevation: {
        md: "shadow-md",
        xl: "shadow-xl",
      },
      radius: {
        lg: "rounded-lg",
        xl: "rounded-xl",
        "2xl": "rounded-2xl",
      },
    },
    defaultVariants: {
      elevation: "md",
      radius: "xl",
    },
  },
)

export interface PopoverSurfaceProps
  extends React.ComponentProps<"div">,
    VariantProps<typeof popoverSurfaceVariants> {
  /** Merges the surface onto the immediate child instead of a div. */
  asChild?: boolean
}

/**
 * A floating overlay surface: the popover-token card that hover cards,
 * pickers, inline dialogs, and quick-create style popups sit on. Purely
 * presentational — positioning, portals, and dismissal stay with the
 * consumer — with `asChild` to project the surface onto another element
 * such as a positioned content node.
 */
function PopoverSurface({
  className,
  elevation,
  radius,
  asChild = false,
  ...props
}: PopoverSurfaceProps) {
  const Comp = asChild ? Slot.Root : "div"
  return (
    <Comp
      data-slot="popover-surface"
      className={cn(popoverSurfaceVariants({ elevation, radius }), className)}
      {...props}
    />
  )
}

export { PopoverSurface, popoverSurfaceVariants }
