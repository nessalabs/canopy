import * as React from "react"
import { DropdownMenu } from "radix-ui"

import { cn } from "@/lib/utils"

export type ComposerAccessModeValue =
  | "full-access"
  | "ask-approval"
  | "auto-approval"

export interface ComposerAccessModeIconProps
  extends React.ComponentProps<"svg"> {
  value: ComposerAccessModeValue
}

// Nucleo icons. See /THIRD_PARTY_NOTICES.md and the tracked Storybook inventory.
function ComposerAccessModeIcon({
  value,
  className,
  ...props
}: ComposerAccessModeIconProps) {
  if (value === "full-access") {
    return (
      <svg
        {...props}
        aria-hidden="true"
        focusable="false"
        width="18"
        height="18"
        viewBox="0 0 18 18"
        className={cn("size-4.5 shrink-0", className)}
        data-access-mode-icon={value}
        data-nucleo-icon="access-full"
      >
        <path
          d="M15.067 2.93298C14.9773 2.88556 14.8826 2.84549 14.7836 2.81368L9.53357 1.13368C9.36084 1.079 9.1795 1.05082 9.00028 1.05075C8.67031 1.05063 8.33372 1.16922 8.16963 1.22703C7.07517 1.61265 5.96344 1.95708 4.85274 2.30119C4.30643 2.47044 3.76038 2.63962 3.21675 2.81358C2.49139 3.04506 2 3.71932 2 4.48V11C2 12.3767 2.75502 13.4762 3.6856 14.3144L15.067 2.93298Z"
          fill="currentColor"
          fillOpacity="0.4"
          data-color="color-2"
        />
        <path
          d="M16 5.18196L5.56107 15.6209C6.74951 16.2793 7.91779 16.6928 8.4601 16.8683C8.76806 16.9684 9.09215 16.9819 9.40737 16.9058C9.49355 16.8849 9.57968 16.8559 9.63302 16.8379C10.9062 16.4082 12.1533 15.8602 13.2749 15.1143C14.6025 14.2314 16 12.8725 16 11V5.18196Z"
          fill="currentColor"
          fillOpacity="0.4"
          data-color="color-2"
        />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M16.5303 1.46967C16.8232 1.76256 16.8232 2.23744 16.5303 2.53033L2.53033 16.5303C2.23744 16.8232 1.76256 16.8232 1.46967 16.5303C1.17678 16.2374 1.17678 15.7626 1.46967 15.4697L15.4697 1.46967C15.7626 1.17678 16.2374 1.17678 16.5303 1.46967Z"
          fill="currentColor"
        />
      </svg>
    )
  }

  return (
    <svg
      {...props}
      aria-hidden="true"
      focusable="false"
      width="18"
      height="18"
      viewBox="0 0 18 18"
      className={cn("size-4.5 shrink-0", className)}
      data-access-mode-icon={value}
      data-nucleo-icon={
        value === "auto-approval"
          ? "access-auto-approval"
          : "access-ask-approval"
      }
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8.16963 1.22703C8.33372 1.16922 8.67031 1.05063 9.00028 1.05075C9.1795 1.05082 9.36084 1.079 9.53357 1.13368L14.7836 2.81368C15.5071 3.04612 16 3.71943 16 4.48V11C16 12.8725 14.6025 14.2314 13.2749 15.1143C12.1533 15.8602 10.9062 16.4082 9.63302 16.8379C9.57968 16.8559 9.49355 16.8849 9.40738 16.9058C9.09216 16.9819 8.76807 16.9684 8.46011 16.8683C7.80803 16.6572 6.25089 16.1022 4.84192 15.1909C3.47441 14.3064 2 12.9239 2 11V4.48C2 3.71932 2.49139 3.04506 3.21675 2.81358C4.86562 2.28594 6.53686 1.80232 8.16963 1.22703Z"
        fill="currentColor"
        fillOpacity="0.4"
        data-color="color-2"
      />
      {value === "auto-approval" ? (
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M11.9549 6.15141C12.2855 6.40097 12.3512 6.87128 12.1016 7.20187L8.70461 11.7019C8.57662 11.8714 8.38274 11.9787 8.17111 11.9972C7.95949 12.0156 7.74997 11.9434 7.59459 11.7986L5.98559 10.2986C5.68261 10.0161 5.66598 9.54155 5.94843 9.23858C6.23088 8.9356 6.70546 8.91896 7.00843 9.20141L8.00877 10.134L10.9044 6.29813C11.154 5.96754 11.6243 5.90185 11.9549 6.15141Z"
          fill="currentColor"
        />
      ) : null}
    </svg>
  )
}

const composerAccessModeLabels: Record<ComposerAccessModeValue, string> = {
  "full-access": "Full access",
  "ask-approval": "Ask for approval",
  "auto-approval": "Auto approval",
}

const composerAccessModes = [
  "ask-approval",
  "auto-approval",
  "full-access",
] as const satisfies readonly ComposerAccessModeValue[]

export interface ComposerAccessModeProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "value" | "defaultValue" | "onChange"> {
  value?: ComposerAccessModeValue
  defaultValue?: ComposerAccessModeValue
  onValueChange?: (value: ComposerAccessModeValue) => void
  showLabel?: boolean
  contentClassName?: string
  portalContainer?: HTMLElement | null
}

const ComposerAccessMode = React.forwardRef<
  HTMLButtonElement,
  ComposerAccessModeProps
>(
  (
    {
      value: valueProp,
      defaultValue = "ask-approval",
      onValueChange,
      showLabel = false,
      contentClassName,
      portalContainer,
      className,
      title,
      ...props
    },
    ref,
  ) => {
    const [uncontrolledValue, setUncontrolledValue] =
      React.useState<ComposerAccessModeValue>(defaultValue)
    const value = valueProp ?? uncontrolledValue
    const label = composerAccessModeLabels[value]

    const setValue = React.useCallback(
      (nextValue: string) => {
        const typedValue = composerAccessModes.find(
          (option) => option === nextValue,
        )
        if (!typedValue) return
        if (valueProp === undefined) setUncontrolledValue(typedValue)
        onValueChange?.(typedValue)
      },
      [onValueChange, valueProp],
    )

    return (
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            ref={ref}
            type="button"
            data-slot="composer-access-mode"
            data-access-mode={value}
            aria-label={`Access mode: ${label}`}
            title={title ?? label}
            className={cn(
              "inline-flex h-9 min-w-0 items-center gap-1.5 rounded-full px-2.5 font-sans nessa-text-4 font-medium text-muted-foreground outline-none transition-[color,background-color,box-shadow] hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50",
              value === "full-access" && "text-destructive",
              className,
            )}
            {...props}
          >
            <ComposerAccessModeIcon value={value} />
            {showLabel ? <span className="truncate">{label}</span> : null}
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal container={portalContainer}>
          <DropdownMenu.Content
            data-slot="composer-access-mode-content"
            side="top"
            align="start"
            sideOffset={8}
            collisionPadding={12}
            className={cn(
              "z-50 min-w-48 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
              contentClassName,
            )}
          >
            <DropdownMenu.Label className="px-2 py-1.5 font-sans nessa-text-2 font-medium text-muted-foreground">
              Access mode
            </DropdownMenu.Label>
            <DropdownMenu.RadioGroup value={value} onValueChange={setValue}>
              {composerAccessModes.map((option) => (
                  <DropdownMenu.RadioItem
                    key={option}
                    value={option}
                    className={cn(
                      "flex min-h-10 cursor-default select-none items-center gap-2 rounded-lg px-2 font-sans nessa-text-4 text-foreground outline-none transition-colors data-[highlighted]:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring data-[state=checked]:bg-accent/70",
                      option === "full-access" && "text-destructive",
                    )}
                  >
                    <ComposerAccessModeIcon value={option} />
                    <span className="flex-1">{composerAccessModeLabels[option]}</span>
                  </DropdownMenu.RadioItem>
                ))}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    )
  },
)
ComposerAccessMode.displayName = "ComposerAccessMode"

export {
  ComposerAccessMode,
  ComposerAccessModeIcon,
  composerAccessModeLabels,
}
