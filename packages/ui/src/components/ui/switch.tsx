"use client"

import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * An on/off toggle for a setting that takes effect immediately, drawn to
 * Checkbox's 18-pixel control scale so the two read as one family in a
 * settings list. Controlled through `checked`/`onCheckedChange` or
 * uncontrolled through `defaultChecked`; `name` and `value` enroll the
 * switch in the surrounding form like a native input. Give it an accessible
 * name through a `label htmlFor`/`id` pair, `aria-label`, or
 * `aria-labelledby`.
 */
function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full border bg-transparent p-px shadow-xs outline-none transition-[border-color,background-color] [transition-duration:var(--nessa-motion-duration-fast)] [transition-timing-function:var(--nessa-motion-easing-standard)] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none",
        // Like Checkbox, the unchecked control is identified by its border
        // alone, so it carries a boundary-strength tone; the checked track
        // takes the same primary wash as a checked box.
        "border-muted-foreground data-[state=checked]:border-primary data-[state=checked]:bg-primary/20",
        "focus-visible:[outline-style:solid] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-3 rounded-full bg-muted-foreground transition-[translate,background-color] [transition-duration:var(--nessa-motion-duration-fast)] [transition-timing-function:var(--nessa-motion-easing-standard)] data-[state=checked]:translate-x-4 data-[state=checked]:bg-primary motion-reduce:transition-none"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
