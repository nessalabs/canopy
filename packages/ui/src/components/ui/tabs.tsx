import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Tabs as TabsPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

import { segmentedShellVariants } from "./segmented-control"

/** @responsibility Provides an accessible tab list and its associated panels. */

export type TabsProps = React.ComponentProps<typeof TabsPrimitive.Root>

/**
 * The tabs root: owns the selected value and the orientation its list and
 * panels share.
 *
 * Selection is uncontrolled through `defaultValue` or host-controlled
 * through `value` and `onValueChange`. `activationMode` decides whether
 * moving focus selects as it goes (`"automatic"`, the default) or whether
 * the reader confirms with Enter or Space (`"manual"`) — prefer manual when
 * a panel is expensive to render or fetches on show.
 *
 * @param props - Radix tabs root properties.
 * @returns A flex container scoping the tab list and panels.
 */
function Tabs({ className, ...props }: TabsProps) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn(
        "flex min-h-0 min-w-0 flex-col gap-2 data-[orientation=vertical]:flex-row",
        className,
      )}
      {...props}
    />
  )
}

/**
 * Creates the class names for a supported tab-list presentation.
 *
 * @param options - Variant and optional class-name selections.
 * @returns The composed class-name string for a tab list.
 */
/** The presentation a `TabsList` falls back to, shared by cva and the DOM attribute. */
const defaultTabsListVariant = "underline" as const

const tabsListVariants = cva(
  "flex min-w-0 shrink-0 items-stretch data-[orientation=vertical]:flex-col data-[orientation=vertical]:items-stretch",
  {
    variants: {
      variant: {
        // The list owns every rule that depends on its own variant and
        // orientation and applies them to its tabs, because a tab cannot
        // read two `group-data-*` conditions off the same ancestor — that
        // compiles to two nested ancestors, and there is only one list.
        underline: [
          "gap-4 border-border data-[orientation=horizontal]:border-b data-[orientation=vertical]:gap-1 data-[orientation=vertical]:border-e",
          // A horizontal strip scrolls rather than crushing its tabs: the
          // tabs keep their natural width and the strip overflows, so a
          // narrow column gets a scrollable strip instead of a cramped one.
          "data-[orientation=horizontal]:overflow-x-auto data-[orientation=horizontal]:[&>[data-slot=tabs-trigger]]:shrink-0",
          "[&>[data-slot=tabs-trigger]]:min-h-9 [&>[data-slot=tabs-trigger]]:px-0.5",
          "[&>[data-slot=tabs-trigger]]:after:absolute [&>[data-slot=tabs-trigger]]:after:bg-transparent [&>[data-slot=tabs-trigger]]:after:transition-colors [&>[data-slot=tabs-trigger]]:after:content-['']",
          // The indicator draws inside the trigger's box, immediately above
          // the strip's rule: a scrolling strip clips both axes, so an
          // overhang would be the part that gets cut.
          "[&>[data-slot=tabs-trigger][data-state=active]]:after:bg-foreground",
          "data-[orientation=horizontal]:[&>[data-slot=tabs-trigger]]:after:inset-x-0 data-[orientation=horizontal]:[&>[data-slot=tabs-trigger]]:after:bottom-0 data-[orientation=horizontal]:[&>[data-slot=tabs-trigger]]:after:h-0.5",
          "data-[orientation=vertical]:[&>[data-slot=tabs-trigger]]:justify-start data-[orientation=vertical]:[&>[data-slot=tabs-trigger]]:px-2.5 data-[orientation=vertical]:[&>[data-slot=tabs-trigger]]:after:inset-y-0 data-[orientation=vertical]:[&>[data-slot=tabs-trigger]]:after:-end-px data-[orientation=vertical]:[&>[data-slot=tabs-trigger]]:after:w-0.5",
        ],
        // The same strip SegmentedControl renders, painted from the same
        // recipe and agreeing with it on the selected treatment — the two
        // read as one control, so they must not diverge.
        pill: [
          segmentedShellVariants(),
          "[&>[data-slot=tabs-trigger]]:min-h-7 [&>[data-slot=tabs-trigger]]:rounded-md [&>[data-slot=tabs-trigger]]:px-2.5",
          "data-[orientation=horizontal]:[&>[data-slot=tabs-trigger]]:flex-1",
          "[&>[data-slot=tabs-trigger]]:hover:bg-accent [&>[data-slot=tabs-trigger]]:hover:text-accent-foreground",
          "[&>[data-slot=tabs-trigger][data-state=active]]:bg-secondary [&>[data-slot=tabs-trigger][data-state=active]]:text-secondary-foreground [&>[data-slot=tabs-trigger][data-state=active]]:shadow-xs",
        ],
      },
    },
    defaultVariants: {
      variant: defaultTabsListVariant,
    },
  },
)

export interface TabsListProps
  extends React.ComponentProps<typeof TabsPrimitive.List>,
    VariantProps<typeof tabsListVariants> {}

/**
 * The `tablist` holding the tabs. Radix supplies roving focus, arrow-key
 * movement along the list's orientation, and Home and End.
 *
 * The variant is also published as `data-variant` so hosts can style
 * against the presentation the list chose.
 *
 * @param props - Radix tab-list properties and the presentation variant.
 * @returns A horizontally or vertically arranged tab list.
 */
function TabsList({ className, variant, ...props }: TabsListProps) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant ?? defaultTabsListVariant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  )
}

export interface TabsTriggerProps
  extends Omit<React.ComponentProps<typeof TabsPrimitive.Trigger>, "asChild"> {
  /** Decorative leading content displayed before the label. */
  icon?: React.ReactNode
  /** Compact count or status displayed after the label. */
  badge?: React.ReactNode
}

/**
 * One tab. Renders its label, an optional leading `icon`, and an optional
 * trailing `badge` such as an unread count.
 *
 * `asChild` is deliberately not part of this surface: the tab renders its
 * icon, label and badge as separate children, and Radix's `Slot` accepts
 * exactly one.
 *
 * The label is wrapped so its selected weight can be reserved at rest: the
 * bold text is rendered invisibly in the same grid cell, which stops the
 * strip from reflowing as selection moves between tabs.
 *
 * @param props - Radix tab properties plus the icon and badge slots.
 * @returns A `tab` control styled for the list variant it sits in.
 */
function TabsTrigger({
  badge,
  children,
  className,
  icon,
  ...props
}: TabsTriggerProps) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "group/tabs-trigger relative inline-flex min-w-0 items-center justify-center gap-1.5 whitespace-nowrap border-0 bg-transparent font-sans nessa-text-4 font-normal text-muted-foreground outline-none transition-[color,background-color,box-shadow] hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 data-[state=active]:text-foreground",
        className,
      )}
      {...props}
    >
      {icon ? (
        <span
          aria-hidden="true"
          className="inline-flex shrink-0 items-center [&>svg]:size-4"
        >
          {icon}
        </span>
      ) : null}
      <span
        data-slot="tabs-trigger-label"
        className="grid min-w-0 grid-cols-1 grid-rows-1 place-items-center"
      >
        <span className="col-start-1 row-start-1 truncate group-data-[state=active]/tabs-trigger:font-medium">
          {children}
        </span>
        {/* Reserves the selected weight's width so the strip never reflows.
            It truncates like the visible copy: left untruncated it sizes the
            grid cell from the full text, and a tab that has to shrink then
            spills its label over its neighbours instead of clipping. */}
        <span
          aria-hidden="true"
          className="invisible col-start-1 row-start-1 truncate font-medium"
        >
          {children}
        </span>
      </span>
      {badge ? (
        <span
          data-slot="tabs-trigger-badge"
          className="inline-flex shrink-0 items-center justify-center nessa-text-2 font-medium tabular-nums text-muted-foreground group-data-[state=active]/tabs-trigger:text-foreground"
        >
          {badge}
        </span>
      ) : null}
    </TabsPrimitive.Trigger>
  )
}

export type TabsContentProps = React.ComponentProps<
  typeof TabsPrimitive.Content
>

/**
 * The panel for one tab. Radix names it from its tab and makes it a focus
 * stop, so a reader arriving from the tab lands on the content.
 *
 * @param props - Radix tab-panel properties.
 * @returns A `tabpanel` that fills the space its host gives it.
 */
function TabsContent({ className, ...props }: TabsContentProps) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn(
        "min-h-0 min-w-0 flex-1 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className,
      )}
      {...props}
    />
  )
}

export { Tabs, TabsContent, TabsList, TabsTrigger, tabsListVariants }
