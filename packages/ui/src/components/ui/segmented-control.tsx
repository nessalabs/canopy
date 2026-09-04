"use client"

import * as React from "react"
import { cva } from "class-variance-authority"

import { cn } from "@/lib/utils"

import { Button } from "./button"

interface SegmentedControlContextValue {
  value: string | null
  setValue: (value: string) => void
}

const SegmentedControlContext =
  React.createContext<SegmentedControlContextValue | null>(null)

/**
 * Creates the class names for the bordered strip a set of compact choices
 * sits in.
 *
 * Shared with `TabsList`'s pill presentation, which renders the same shell:
 * two strips a reader sees as one control should not be painted from two
 * literals that drift apart. Exported as a variants function rather than a
 * class constant so it stays statically validatable in the consuming module,
 * the way `popoverSurfaceVariants` is.
 *
 * @returns The composed class-name string for a segmented strip.
 */
const segmentedShellVariants = cva(
  "flex items-center gap-0.5 rounded-lg border border-border p-0.5",
)

export interface SegmentedControlProps
  extends Omit<React.ComponentProps<"div">, "onChange"> {
  /** Controlled selected option value. */
  value?: string
  /** Initial selected option when uncontrolled. */
  defaultValue?: string
  /** Fires with the newly selected option value. */
  onValueChange?: (value: string) => void
}

/**
 * A compact single-choice switcher: a bordered pill of pressed/unpressed
 * buttons, the pattern used for view and scale toggles across Nessa's
 * toolbars. One option is always selected; choosing another moves the
 * pressed state and fires `onValueChange`. Give the group an `aria-label`
 * naming the choice it controls.
 */
function SegmentedControl({
  className,
  value: valueProp,
  defaultValue,
  onValueChange,
  ...props
}: SegmentedControlProps) {
  const [uncontrolledValue, setUncontrolledValue] = React.useState<
    string | null
  >(defaultValue ?? null)
  const value = valueProp !== undefined ? valueProp : uncontrolledValue

  const setValue = React.useCallback(
    (next: string) => {
      if (valueProp === undefined) setUncontrolledValue(next)
      onValueChange?.(next)
    },
    [valueProp, onValueChange],
  )

  const context = React.useMemo(
    () => ({ value, setValue }),
    [value, setValue],
  )

  return (
    <SegmentedControlContext.Provider value={context}>
      <div
        role="group"
        data-slot="segmented-control"
        className={cn(segmentedShellVariants(), className)}
        {...props}
      />
    </SegmentedControlContext.Provider>
  )
}

export interface SegmentedControlOptionProps
  extends Omit<React.ComponentProps<typeof Button>, "value"> {
  /** The value this option selects. */
  value: string
}

/**
 * One choice inside a `SegmentedControl`. Renders as a small button whose
 * pressed state tracks the group's value.
 */
function SegmentedControlOption({
  className,
  value,
  onClick,
  ...props
}: SegmentedControlOptionProps) {
  const context = React.useContext(SegmentedControlContext)
  if (!context) {
    throw new Error(
      "SegmentedControlOption must be used within a SegmentedControl.",
    )
  }
  const selected = context.value === value

  return (
    <Button
      data-slot="segmented-control-option"
      variant={selected ? "secondary" : "ghost"}
      size="sm"
      className={cn("h-7", className)}
      aria-pressed={selected}
      onClick={(domEvent) => {
        onClick?.(domEvent)
        if (!domEvent.defaultPrevented) context.setValue(value)
      }}
      {...props}
    />
  )
}

export { SegmentedControl, SegmentedControlOption, segmentedShellVariants }
