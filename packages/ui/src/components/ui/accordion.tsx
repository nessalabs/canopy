import * as React from "react"
import { Accordion as AccordionPrimitive } from "radix-ui"
import { ChevronDown } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * The accordion root: vertically stacked disclosure sections. `type="single"`
 * keeps at most one section open (add `collapsible` to allow closing it
 * again); `type="multiple"` lets sections open independently. Controlled
 * through `value`/`onValueChange` or uncontrolled through `defaultValue`.
 */
function Accordion({
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Root>) {
  return <AccordionPrimitive.Root data-slot="accordion" {...props} />
}

/**
 * One section: a trigger row plus its collapsible content, identified by
 * `value`. Sections separate with the design system's hairline rule; the
 * last item drops its rule so the accordion composes cleanly against
 * whatever follows it.
 */
function AccordionItem({
  className,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Item>) {
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      className={cn("border-b border-border last:border-b-0", className)}
      {...props}
    />
  )
}

/**
 * The row that opens and closes a section: a full-width heading-wrapped
 * button with a trailing chevron that rotates while the section is open.
 * Radix reports the state through `aria-expanded` and wires the trigger to
 * its content region.
 */
function AccordionTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Trigger>) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          // Trigger rows stack flush between the item hairlines, so the
          // outline draws inset to stay off the rules and neighboring rows.
          "flex flex-1 items-center justify-between gap-4 py-3 text-left font-sans nessa-text-4 font-medium text-foreground outline-none transition-colors [transition-duration:var(--nessa-motion-duration-fast)] [transition-timing-function:var(--nessa-motion-easing-standard)] hover:underline hover:underline-offset-4 focus-visible:[outline-style:solid] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none [&[data-state=open]>svg]:rotate-180",
          className,
        )}
        {...props}
      >
        {children}
        <ChevronDown
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground transition-transform [transition-duration:var(--nessa-motion-duration-normal)] [transition-timing-function:var(--nessa-motion-easing-standard)] motion-reduce:transition-none"
        />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  )
}

/**
 * The collapsible body of a section. Height animates open and closed through
 * Radix's measured `--radix-accordion-content-height` with the motion
 * tokens, collapsing to an instant cut under reduced motion; `className`
 * extends the inner padded block rather than the clipping wrapper.
 */
function AccordionContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Content>) {
  return (
    <AccordionPrimitive.Content
      data-slot="accordion-content"
      className="overflow-hidden font-sans nessa-text-4 text-foreground data-[state=closed]:animate-nessa-accordion-up data-[state=open]:animate-nessa-accordion-down"
      {...props}
    >
      <div className={cn("pb-3", className)}>{children}</div>
    </AccordionPrimitive.Content>
  )
}

export { Accordion, AccordionContent, AccordionItem, AccordionTrigger }
