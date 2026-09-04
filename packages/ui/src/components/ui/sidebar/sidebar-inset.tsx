import * as React from "react"

import { cn } from "@/lib/utils"

/** @responsibility Provides the primary workspace region adjacent to a Sidebar. */

/**
 * Renders the primary application workspace adjacent to a Sidebar.
 *
 * When the sibling Sidebar uses the inset variant, the workspace floats as a
 * rounded panel beside the flush Sidebar surface.
 *
 * @param props - Native main properties, including children and optional styling overrides.
 * @returns A flexible main landmark that fills the remaining shell width.
 */
function SidebarInset({ className, ...props }: React.ComponentProps<"main">) {
  return (
    <main
      data-slot="sidebar-inset"
      className={cn(
        "relative flex min-w-0 flex-1 flex-col bg-background",
        "md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm",
        "md:peer-data-[variant=inset]:peer-data-[side=left]:ml-0 md:peer-data-[variant=inset]:peer-data-[side=right]:mr-0",
        className,
      )}
      {...props}
    />
  )
}

export { SidebarInset }
