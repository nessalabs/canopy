import * as React from "react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"
import { popoverSurfaceVariants } from "./popover-surface"

/**
 * The dialog root: owns open state and coordinates the trigger, the overlay,
 * and the modal content. Controlled through `open`/`onOpenChange` or
 * uncontrolled through `defaultOpen`.
 */
function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

/**
 * The element that opens the dialog. Renders its child as the trigger via
 * `asChild`, so any Nessa button can launch a dialog.
 */
function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

/**
 * Closes the dialog when activated. Renders its child via `asChild`, so a
 * footer's Cancel button dismisses without the host wiring open state.
 */
function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

export interface DialogContentProps
  extends React.ComponentProps<typeof DialogPrimitive.Content> {
  /** Portal container for the overlay and content; defaults to the body. */
  portalContainer?: HTMLElement | null
  /**
   * Hides the corner close button when false. Keep it for confirmation
   * dialogs whose only exits should be the explicit footer actions.
   */
  showCloseButton?: boolean
}

/**
 * The modal surface: a centered popover-surface card behind a blurred
 * background scrim, portalled into `portalContainer` (or the body). Radix
 * traps focus inside, closes on Escape or scrim click, and requires a
 * `DialogTitle` inside for the accessible name; pair it with a
 * `DialogDescription` or pass `aria-describedby={undefined}`.
 */
function DialogContent({
  className,
  children,
  portalContainer,
  showCloseButton = true,
  ...props
}: DialogContentProps) {
  return (
    <DialogPrimitive.Portal container={portalContainer}>
      <DialogPrimitive.Overlay
        data-slot="dialog-overlay"
        className="fixed inset-0 z-50 bg-background/80 backdrop-blur-xs data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
      />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          popoverSurfaceVariants({ elevation: "xl", radius: "xl" }),
          "fixed left-1/2 top-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 p-6 nessa-text-4 outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 sm:max-w-lg",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close-button"
            className="absolute right-4 top-4 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors [transition-duration:var(--nessa-motion-duration-fast)] [transition-timing-function:var(--nessa-motion-easing-standard)] hover:bg-accent hover:text-accent-foreground focus-visible:[outline-style:solid] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none motion-reduce:transition-none"
          >
            <X aria-hidden="true" className="size-4 shrink-0" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

/** Leading block for the title and description, left-aligned from `sm` up. */
function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-1.5 text-center sm:text-left", className)}
      {...props}
    />
  )
}

/**
 * Trailing action row. Actions stack full-width on narrow viewports and
 * right-align in reading order from `sm` up, primary action last.
 */
function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  )
}

/**
 * The dialog's accessible name. Required inside every `DialogContent`;
 * Radix announces it when the dialog opens.
 */
function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("nessa-text-6 font-semibold", className)}
      {...props}
    />
  )
}

/**
 * Supporting copy under the title, announced as the dialog's accessible
 * description.
 */
function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("nessa-text-4 text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
}
