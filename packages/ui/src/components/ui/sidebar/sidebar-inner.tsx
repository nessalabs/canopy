import * as React from "react"

import { cn } from "@/lib/utils"

import {
  SidebarCollapsible,
  SidebarSide,
  type SidebarCollapsible as SidebarCollapsibleType,
  type SidebarSide as SidebarSideType,
} from "./sidebar-options"

/** @responsibility Applies the shared visual and visibility behavior to Sidebar contents. */

/** Inputs used by Sidebar to render its shared inner container. */
interface SidebarInnerProps extends React.ComponentProps<"div"> {
  /** Collapse behavior applied by the owning Sidebar. */
  collapsible: SidebarCollapsibleType
  /** Whether the owning Sidebar is currently collapsed. */
  collapsed: boolean
  /** Physical edge on which the owning Sidebar is positioned. */
  side: SidebarSideType
}

/**
 * Renders the shared visual container inside desktop and mobile Sidebars.
 *
 * @param props - Visibility, collapse, side, and native div properties supplied by Sidebar.
 * @returns The styled inner container with the requested collapse presentation.
 */
function SidebarInner({
  collapsible,
  collapsed,
  side,
  className,
  ...props
}: SidebarInnerProps) {
  const isOffcanvasHidden =
    collapsed && collapsible === SidebarCollapsible.Offcanvas
  const isIconCollapsed =
    collapsed && collapsible === SidebarCollapsible.Icon
  const isLeft = side === SidebarSide.Left

  return (
    <div
      data-slot="sidebar-inner"
      aria-hidden={isOffcanvasHidden || undefined}
      inert={isOffcanvasHidden || undefined}
      className={cn(
        "flex h-full min-h-0 w-(--nessa-sidebar-width) flex-col overflow-hidden bg-sidebar transition-transform duration-200 ease-linear",
        isIconCollapsed && "w-(--nessa-sidebar-width-icon)",
        isOffcanvasHidden &&
          (isLeft ? "-translate-x-full" : "translate-x-full"),
        className,
      )}
      {...props}
    />
  )
}

export { SidebarInner, type SidebarInnerProps }
