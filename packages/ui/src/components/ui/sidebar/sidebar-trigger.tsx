"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

import { useSidebar } from "./sidebar-provider"

/** @responsibility Provides an explicit control for changing shared Sidebar visibility. */

/**
 * Renders an explicit control that toggles the nearest Sidebar provider.
 *
 * @param props - Native button properties, visible content, and an optional cancellable click handler.
 * @returns An accessible Sidebar toggle button containing the supplied children.
 */
function SidebarTrigger({
  className,
  onClick,
  children,
  ...props
}: React.ComponentProps<"button">) {
  const { lastTriggerRef, open, toggleSidebar } = useSidebar()

  return (
    <button
      type="button"
      data-slot="sidebar-trigger"
      aria-label="Toggle sidebar"
      title="Toggle sidebar"
      className={cn(
        "inline-flex size-8 shrink-0 appearance-none items-center justify-center rounded-md border-0 bg-transparent p-0 text-sidebar-foreground/60 outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sidebar-ring [&>svg]:size-4",
        className,
      )}
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented) {
          if (!open) lastTriggerRef.current = event.currentTarget
          toggleSidebar()
        }
      }}
      {...props}
    >
      {children}
    </button>
  )
}

export { SidebarTrigger }
