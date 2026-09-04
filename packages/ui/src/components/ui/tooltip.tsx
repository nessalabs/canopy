"use client"

import * as React from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { popoverSurfaceVariants } from "./popover-surface"

/**
 * Shares tooltip timing across a region. Tooltips inside one provider skip
 * the open delay when the pointer moves between neighboring triggers — wrap
 * a toolbar of icon buttons in one so only the first tooltip waits. Optional:
 * a bare Tooltip provides its own.
 */
function TooltipProvider({
  delayDuration = 300,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

/**
 * The tooltip root: a hover/focus label naming or explaining its trigger.
 * Opens after the surrounding provider's delay and coordinates the trigger
 * with the floating content. Purely supplementary — the trigger still needs
 * its own accessible name. For the floating selection-action pill, see
 * SelectionTooltip; this is the plain hover tooltip.
 */
function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return (
    <TooltipProvider>
      <TooltipPrimitive.Root data-slot="tooltip" {...props} />
    </TooltipProvider>
  )
}

/**
 * The element the tooltip describes. Renders its child as the trigger via
 * `asChild`, so any Nessa button or chip can carry a tooltip.
 */
function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

export interface TooltipContentProps
  extends React.ComponentProps<typeof TooltipPrimitive.Content> {
  /** Portal container for the floating content; defaults to the body. */
  portalContainer?: HTMLElement | null
}

/**
 * The floating label: a compact popover-surface pill portalled into
 * `portalContainer` (or the body). Keep the content to a short phrase —
 * anything interactive belongs in a popover or menu, not a tooltip.
 */
function TooltipContent({
  className,
  sideOffset = 6,
  collisionPadding = 12,
  portalContainer,
  ...props
}: TooltipContentProps) {
  return (
    <TooltipPrimitive.Portal container={portalContainer}>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          popoverSurfaceVariants({ elevation: "md", radius: "lg" }),
          "z-50 max-w-72 origin-(--radix-tooltip-content-transform-origin) text-balance px-2.5 py-1 nessa-text-2 data-[state=closed]:animate-out data-[state=delayed-open]:animate-in data-[state=instant-open]:animate-in data-[state=closed]:fade-out-0 data-[state=delayed-open]:fade-in-0 data-[state=instant-open]:fade-in-0",
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
