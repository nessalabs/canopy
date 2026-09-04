"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

/** @responsibility Provides the Sidebar icon action control and its shared presentation. */

/**
 * Creates the class names for a Sidebar icon action control.
 *
 * A group's action and a row's action are the same control in two
 * placements, so they share one recipe rather than two hand-rolled class
 * strings that drift on tone and icon scale. Placement stays with the
 * caller: the group's action is pinned to its header, the row's action sits
 * in the row's trailing region.
 *
 * @param options - Size and optional class-name selections.
 * @returns The composed class-name string for a Sidebar action control.
 */
const sidebarActionVariants = cva(
  "inline-flex shrink-0 appearance-none items-center justify-center rounded-md border-0 bg-transparent p-0 text-sidebar-foreground/60 outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sidebar-ring disabled:pointer-events-none disabled:opacity-50 [&>svg]:shrink-0",
  {
    variants: {
      size: {
        /** Fits a menu row's trailing band beside a badge. */
        sm: "size-6 [&>svg]:size-3.5",
        /** Fits a group header, which sets its own larger rhythm. */
        md: "size-7 [&>svg]:size-4",
      },
    },
    defaultVariants: {
      size: "sm",
    },
  },
)

type SidebarActionSize = NonNullable<
  VariantProps<typeof sidebarActionVariants>["size"]
>

/** Properties accepted by a trailing action control on a Sidebar row or group. */
interface SidebarActionProps
  extends React.ComponentProps<"button">,
    VariantProps<typeof sidebarActionVariants> {
  /**
   * Merges control behavior and styling into the single child element, for a
   * menu or dialog trigger that must own the rendered control.
   * @defaultValue false
   */
  asChild?: boolean
}

/**
 * An icon control for a Sidebar row or group's trailing region — row settings, a
 * kebab menu, a dismiss. Give it an `aria-label`: it is icon-only, and it
 * sits beside the row's own control rather than inside it, so it needs its
 * own name.
 *
 * @param props - Native button properties and whether to merge into a child.
 * @returns A compact control styled for the Sidebar's trailing region.
 */
function SidebarAction({
  asChild = false,
  className,
  size,
  ...props
}: SidebarActionProps) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      type={asChild ? undefined : "button"}
      data-slot="sidebar-action"
      data-sidebar="action"
      className={cn(sidebarActionVariants({ size }), className)}
      {...props}
    />
  )
}

export {
  SidebarAction,
  sidebarActionVariants,
  type SidebarActionProps,
  type SidebarActionSize,
}

