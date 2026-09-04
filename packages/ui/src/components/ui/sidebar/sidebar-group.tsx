import * as React from "react"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

import { sidebarActionVariants } from "./sidebar-action"

/** @responsibility Organizes related Sidebar content under an optional label and action. */

/**
 * Renders a semantic section for related Sidebar content.
 *
 * @param props - Native section properties, including the group's children and styling overrides.
 * @returns A positioned Sidebar section that can coordinate its label, action, and content.
 */
function SidebarGroup({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      data-slot="sidebar-group"
      className={cn("relative flex w-full min-w-0 flex-col py-2", className)}
      {...props}
    />
  )
}

/**
 * Renders the accessible heading for a Sidebar group.
 *
 * @param props - Native heading properties, including label content and styling overrides.
 * @returns A level-two heading that follows the Sidebar's collapsed-state presentation.
 */
function SidebarGroupLabel({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <h2
      data-slot="sidebar-group-label"
      className={cn(
        "flex min-h-8 shrink-0 items-center px-2.5 nessa-text-2 font-medium text-sidebar-foreground/60 transition-[height,margin,opacity] duration-200 group-data-[state=collapsed]/sidebar:-mt-8 group-data-[state=collapsed]/sidebar:opacity-0",
        className,
      )}
      {...props}
    />
  )
}

/** Properties accepted by the optional action associated with a Sidebar group. */
interface SidebarGroupActionProps extends React.ComponentProps<"button"> {
  /**
   * Merges behavior and styling into the single child element instead of rendering a button.
   * @defaultValue false
   */
  asChild?: boolean
}

/**
 * Renders an optional action associated with a Sidebar group.
 *
 * @param props - Button properties and optional child-composition behavior.
 * @returns A group-aligned action control, or the supplied child when `asChild` is enabled.
 */
function SidebarGroupAction({
  asChild = false,
  className,
  ...props
}: SidebarGroupActionProps) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      type={asChild ? undefined : "button"}
      data-slot="sidebar-group-action"
      data-sidebar="group-action"
      className={cn(
        sidebarActionVariants({ size: "md" }),
        // Placement stays with the caller; only the control's own
        // presentation is shared.
        "absolute end-2 top-2.5 group-data-[state=collapsed]/sidebar:hidden",
        className,
      )}
      {...props}
    />
  )
}

/**
 * Renders the body region of a Sidebar group.
 *
 * @param props - Native div properties, including grouped content and styling overrides.
 * @returns A full-width container for the group's Sidebar content.
 */
function SidebarGroupContent({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group-content"
      className={cn("w-full nessa-text-4", className)}
      {...props}
    />
  )
}

export {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  type SidebarGroupActionProps,
}
