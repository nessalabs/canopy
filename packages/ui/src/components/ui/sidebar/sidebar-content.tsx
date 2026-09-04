import * as React from "react"

import { cn } from "@/lib/utils"

/** @responsibility Provides the flexible content region for primary Sidebar navigation. */

/**
 * Renders the scrollable region that contains a Sidebar's primary content.
 *
 * @param props - Native div properties, including children and optional styling overrides.
 * @returns A flexible, vertically scrollable Sidebar content container.
 */
function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-content"
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden overscroll-contain px-2 pb-3",
        className,
      )}
      {...props}
    />
  )
}

export { SidebarContent }
