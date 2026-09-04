import * as React from "react"

import { cn } from "@/lib/utils"

import { useSidebar } from "./sidebar-provider"

/** @responsibility Provides a full-height edge target for changing Sidebar visibility. */

/**
 * Renders an edge-aligned pointer target that toggles the nearest Sidebar provider.
 *
 * @param props - Native button properties and an optional click handler that may cancel toggling.
 * @returns A full-height, visually unobtrusive Sidebar toggle button.
 */
function SidebarRail({
  className,
  onClick,
  ...props
}: React.ComponentProps<"button">) {
  const { toggleSidebar } = useSidebar()

  return (
    <button
      type="button"
      data-slot="sidebar-rail"
      aria-label="Toggle sidebar"
      title="Toggle sidebar"
      tabIndex={-1}
      className={cn(
        "absolute inset-y-0 z-10 hidden w-3 appearance-none border-0 bg-transparent p-0 opacity-0 transition-opacity hover:opacity-100 sm:block",
        "group-data-[side=left]/sidebar:-right-1.5 group-data-[side=right]/sidebar:-left-1.5",
        className,
      )}
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented) toggleSidebar()
      }}
      {...props}
    />
  )
}

export { SidebarRail }
