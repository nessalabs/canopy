import * as React from "react"

import { cn } from "@/lib/utils"

/** @responsibility Provides the leading region for Sidebar identity and primary controls. */

/**
 * Renders the leading region for Sidebar identity and primary controls.
 *
 * @param props - Native div properties, including children and optional styling overrides.
 * @returns A non-shrinking header container at the start of the Sidebar.
 */
function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-header"
      className={cn("flex shrink-0 flex-col gap-2 p-3", className)}
      {...props}
    />
  )
}

export { SidebarHeader }
