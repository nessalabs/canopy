import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const statusDotVariants = cva("inline-block size-2 shrink-0 rounded-full", {
  variants: {
    status: {
      running: "bg-nessa-thinking-fill-current animate-pulse",
      success: "bg-nessa-diff-addition",
      error: "bg-destructive",
      idle: "bg-muted-foreground/50",
    },
  },
  defaultVariants: {
    status: "idle",
  },
})

export interface StatusDotProps
  extends React.ComponentProps<"span">,
    VariantProps<typeof statusDotVariants> {}

/**
 * A small colored dot conveying run state at a glance. Pair it with a text
 * label; the dot alone is not accessible. Decorative by default — pass an
 * `aria-label` only when no visible label accompanies it.
 */
function StatusDot({ className, status, ...props }: StatusDotProps) {
  return (
    <span
      data-slot="status-dot"
      aria-hidden={props["aria-label"] ? undefined : true}
      className={cn(statusDotVariants({ status }), className)}
      {...props}
    />
  )
}

export { StatusDot, statusDotVariants }
