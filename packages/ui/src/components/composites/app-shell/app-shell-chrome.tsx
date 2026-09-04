import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Renders the shell's top chrome region.
 *
 * @param props - Native header properties.
 * @returns A fixed-height header row above the shell body.
 */
function AppShellHeader({
  className,
  ...props
}: React.ComponentProps<"header">) {
  return (
    <header
      data-slot="app-shell-header"
      className={cn(
        "flex h-12 shrink-0 items-center gap-2 border-b border-border px-3",
        className,
      )}
      {...props}
    />
  )
}

/**
 * Renders the shell's middle row hosting the docks and the main column.
 *
 * @param props - Native container properties.
 * @returns A flexible row between the header and status bar.
 */
function AppShellBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="app-shell-body"
      className={cn("flex min-h-0 w-full flex-1", className)}
      {...props}
    />
  )
}

/**
 * Renders the shell's center column hosting the workspace and bottom dock.
 *
 * @param props - Native container properties.
 * @returns A flexible column between the left and right docks.
 */
function AppShellMain({ className, ...props }: React.ComponentProps<"main">) {
  return (
    <main
      data-slot="app-shell-main"
      className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}
      {...props}
    />
  )
}

/**
 * Renders the shell's bottom status region.
 *
 * @param props - Native container properties.
 * @returns A fixed-height status row below the shell body.
 */
function AppShellStatusBar({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="app-shell-status-bar"
      className={cn(
        "flex h-8 shrink-0 items-center gap-2 border-t border-border px-3 nessa-text-2 text-muted-foreground",
        className,
      )}
      {...props}
    />
  )
}

export { AppShellBody, AppShellHeader, AppShellMain, AppShellStatusBar }
