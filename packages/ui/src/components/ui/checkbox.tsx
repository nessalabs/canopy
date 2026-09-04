import * as React from "react"

import { cn } from "@/lib/utils"

export interface CheckboxProps
  extends Omit<React.ComponentProps<"input">, "type"> {
  /**
   * Renders the mixed state: a dash instead of a check. Use for a select-all
   * control whose rows are only partly selected.
   *
   * The DOM `indeterminate` flag is a property rather than an attribute, and
   * the browser clears it on every click, so the prop stays the source of
   * truth: it is re-applied both after each render and synchronously on
   * click, since a click the host does not re-render from would otherwise
   * leave the flag cleared.
   *
   * Because the prop wins on every click, a mixed control is effectively
   * controlled — clear `indeterminate` from your `onChange` handler, or the
   * checkbox will keep returning to mixed and never appear to respond.
   */
  indeterminate?: boolean
  /**
   * Extends the box itself. `className` extends the outer wrapper, which is
   * what sizes the control; every other prop — including `style` and
   * `data-*` — lands on the input.
   */
  inputClassName?: string
}

/**
 * The check glyph's path on the 18-unit control viewBox. Shared so
 * companion surfaces that draw a matching check — TaskList's read-only
 * done indicator — can never drift from the Checkbox's own glyph.
 */
export const checkboxCheckPath = "M5.75 9.25L8 11.75L12.25 6.25"

/**
 * A checkbox: a real `input type="checkbox"` styled in place, so keyboard
 * and form semantics stay native and `FormData` sees the value. Supports the
 * mixed state through `indeterminate`, and composes into a label row or a
 * table selection cell.
 */
function Checkbox({
  indeterminate = false,
  inputClassName,
  className,
  onClick,
  ref,
  ...props
}: CheckboxProps) {
  const innerRef = React.useRef<HTMLInputElement>(null)

  React.useImperativeHandle(ref, () => innerRef.current as HTMLInputElement, [])

  // Covers every render the host does drive.
  React.useEffect(() => {
    const element = innerRef.current
    if (element) element.indeterminate = indeterminate
  })

  return (
    <span
      data-slot="checkbox"
      // A styling and test hook for hosts; the component's own mixed-state
      // styling is driven from the prop below rather than this attribute.
      data-indeterminate={indeterminate || undefined}
      className={cn(
        // Fading the whole control keeps the box and its glyph in step; a
        // per-element opacity would leave a full-strength check on a faded
        // box when a checked control is disabled.
        "relative inline-flex size-4.5 shrink-0 text-primary has-[:disabled]:opacity-50",
        className,
      )}
    >
      <input
        ref={innerRef}
        type="checkbox"
        // Mirrors the property so the mixed state is already correct in
        // server-rendered markup, where a DOM property cannot exist. Both
        // read the same prop, so the two can never disagree.
        aria-checked={indeterminate ? "mixed" : undefined}
        onClick={(event) => {
          // The click already cleared the flag. Restore it here rather than
          // waiting for an effect, which never runs if the host's state does
          // not change in response.
          event.currentTarget.indeterminate = indeterminate
          onClick?.(event)
        }}
        className={cn(
          "peer m-0 size-full cursor-pointer appearance-none rounded-xs border bg-transparent shadow-xs outline-none transition-[border-color,background-color] [transition-duration:var(--nessa-motion-duration-fast)] [transition-timing-function:var(--nessa-motion-easing-standard)] checked:border-primary checked:bg-primary/20 disabled:cursor-not-allowed motion-reduce:transition-none",
          // The border is the only evidence an unchecked box is there, so it
          // carries a boundary-strength tone rather than the fainter input
          // hairline used by fields that also have text to identify them.
          "border-muted-foreground",
          // Driven by the prop, not `:indeterminate`, so the very first paint
          // is already correct — the DOM flag only exists after mount.
          indeterminate && "border-primary bg-primary/20",
          "focus-visible:[outline-style:solid] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          inputClassName,
        )}
        {...props}
      />
      <svg
        aria-hidden="true"
        viewBox="0 0 18 18"
        data-slot="checkbox-indicator"
        className={cn(
          "pointer-events-none absolute inset-0 size-full opacity-0 transition-opacity [transition-duration:var(--nessa-motion-duration-fast)] [transition-timing-function:var(--nessa-motion-easing-standard)] peer-checked:opacity-100 motion-reduce:transition-none",
          indeterminate && "opacity-100",
        )}
      >
        <path
          d={indeterminate ? "M5.5 9H12.5" : checkboxCheckPath}
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
    </span>
  )
}

export { Checkbox }
