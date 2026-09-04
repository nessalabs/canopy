import * as React from "react"

import { cn } from "@/lib/utils"

/** @responsibility Provides the terminal region for persistent Sidebar actions or identity. */

/**
 * Renders the terminal region for persistent Sidebar content.
 *
 * @param props - Native div properties, including children and optional styling overrides.
 * @returns A footer container anchored after the Sidebar's flexible content.
 */
function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-footer"
      className={cn(
        "mt-auto flex shrink-0 flex-col gap-1 border-t border-sidebar-border p-2",
        className,
      )}
      {...props}
    />
  )
}

export { SidebarFooter }
