"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

const DEFAULT_SIDEBAR_WIDTH = "17rem"
const DEFAULT_SIDEBAR_COLLAPSED_WIDTH = "3.5rem"
const SIDEBAR_MOBILE_BREAKPOINT = "(max-width: 47.999rem)"

/** @responsibility Coordinates shared Sidebar state, shell sizing, focus, and optional commands. */

type SidebarState = "expanded" | "collapsed"
/** Primary modifier choices supported by an exact Sidebar keyboard shortcut. */
type SidebarShortcutModifier = "control" | "meta" | "mod"

/** Describes one exact, opt-in global keyboard shortcut for toggling a Sidebar. */
interface SidebarKeyboardShortcut {
  /**
   * KeyboardEvent key matched without case sensitivity. When `altKey` is
   * required, single letters and digits also match by physical key so Alt
   * combinations work on platforms that remap the produced character.
   */
  key: string
  /**
   * Primary modifier. `mod` accepts exactly one of Meta or Control; omit for
   * neither. Shortcuts without a primary modifier are ignored while the user
   * types in an editable element so plain keystrokes are never swallowed.
   * @defaultValue undefined
   */
  modifier?: SidebarShortcutModifier
  /**
   * Whether Alt must be pressed. Omitted values require Alt not to be pressed.
   * @defaultValue false
   */
  altKey?: boolean
  /**
   * Whether Shift must be pressed. Omitted values require Shift not to be pressed.
   * @defaultValue false
   */
  shiftKey?: boolean
  /**
   * Prevents the matched browser event by default. Set false to preserve it.
   * @defaultValue true
   */
  preventDefault?: boolean
}

/**
 * Determines whether a keyboard event exactly matches a requested primary modifier.
 *
 * @param event - The keyboard event being evaluated.
 * @param modifier - The required primary modifier, or undefined when neither is allowed.
 * @returns Whether the event's Control and Meta keys satisfy the requested modifier.
 */
function matchesShortcutModifier(
  event: KeyboardEvent,
  modifier: SidebarShortcutModifier | undefined,
) {
  switch (modifier) {
    case "mod":
      return event.metaKey !== event.ctrlKey
    case "meta":
      return event.metaKey && !event.ctrlKey
    case "control":
      return event.ctrlKey && !event.metaKey
    case undefined:
      return !event.metaKey && !event.ctrlKey
    default: {
      const exhaustiveModifier: never = modifier
      return exhaustiveModifier
    }
  }
}

/** Keyboard events already claimed by one provider's shortcut handler. */
const handledShortcutEvents = new WeakSet<KeyboardEvent>()

/**
 * Determines whether a keyboard event originates from a text-editing element.
 *
 * @param event - The keyboard event being evaluated.
 * @returns Whether the event target consumes plain keystrokes for editing.
 */
function isEditableShortcutTarget(event: KeyboardEvent) {
  const target = event.target

  if (!(target instanceof HTMLElement)) return false

  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  )
}

/**
 * Determines whether a keyboard event matches the configured shortcut key.
 *
 * @param event - The keyboard event being evaluated.
 * @param key - The configured shortcut key, matched without case sensitivity.
 * @param altKeyRequired - Whether the shortcut requires Alt, enabling physical-key matching.
 * @returns Whether the event's produced or physical key satisfies the shortcut key.
 */
function matchesShortcutKey(event: KeyboardEvent, key: string, altKeyRequired: boolean) {
  const normalizedKey = key.toLowerCase()

  if (event.key.toLowerCase() === normalizedKey) return true
  if (!altKeyRequired || !/^[a-z0-9]$/.test(normalizedKey)) return false

  const physicalCode = /^[0-9]$/.test(normalizedKey)
    ? `digit${normalizedKey}`
    : `key${normalizedKey}`

  return event.code.toLowerCase() === physicalCode
}

/** State and controls returned by `useSidebar`. */
interface SidebarContextValue {
  /** Semantic presentation derived from the current visibility. */
  state: SidebarState
  /** Whether the coordinated Sidebar is currently open. */
  open: boolean
  /** Updates Sidebar visibility from a value or state updater. */
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
  /** Reverses the current Sidebar visibility. */
  toggleSidebar: () => void
  /** Wrapper used as the portal boundary for mobile Sidebar content. */
  portalContainerRef: React.RefObject<HTMLDivElement | null>
  /** Most recent trigger used for mobile focus restoration. */
  lastTriggerRef: React.RefObject<HTMLElement | null>
}

const SidebarContext = React.createContext<SidebarContextValue | null>(null)

/**
 * Subscribes to changes of the Sidebar's mobile media query.
 *
 * @param onChange - Called whenever the media-query match state changes.
 * @returns A cleanup function that removes the subscription.
 */
function subscribeToMobileViewport(onChange: () => void) {
  const mediaQuery = window.matchMedia(SIDEBAR_MOBILE_BREAKPOINT)

  mediaQuery.addEventListener("change", onChange)
  return () => mediaQuery.removeEventListener("change", onChange)
}

/**
 * Reads whether the mobile Sidebar media query currently matches.
 *
 * @returns The current mobile media-query match state.
 */
function getIsMobileSnapshot() {
  return window.matchMedia(SIDEBAR_MOBILE_BREAKPOINT).matches
}

/**
 * Provides the server-render value for the mobile media query.
 *
 * @returns False, so server markup always renders the desktop presentation.
 */
function getServerIsMobileSnapshot() {
  return false
}

/**
 * Observes whether the current viewport uses the Sidebar's mobile presentation.
 *
 * @returns Whether the mobile Sidebar media query currently matches.
 */
function useIsMobile() {
  return React.useSyncExternalStore(
    subscribeToMobileViewport,
    getIsMobileSnapshot,
    getServerIsMobileSnapshot,
  )
}

/**
 * Reads the shared state and controls for the nearest Sidebar provider.
 *
 * @returns The current Sidebar state, state controls, and focus-management references.
 * @throws When called outside a SidebarProvider.
 */
function useSidebar() {
  const context = React.useContext(SidebarContext)

  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.")
  }

  return context
}

/** Properties accepted by the shared Sidebar state and layout provider. */
interface SidebarProviderProps extends React.ComponentProps<"div"> {
  /**
   * Width used by icon-collapsed Sidebars.
   * @defaultValue "3.5rem"
   */
  collapsedSidebarWidth?: string
  /**
   * Initial visibility for an uncontrolled provider.
   * @defaultValue true
   */
  defaultOpen?: boolean
  /** Current visibility when the provider is controlled by its consumer. */
  open?: boolean
  /** Called whenever a consumer interaction requests a visibility change. */
  onOpenChange?: (open: boolean) => void
  /**
   * Exact global shortcut for toggling. Omit to disable keyboard toggling.
   * @defaultValue undefined
   */
  keyboardShortcut?: SidebarKeyboardShortcut
  /**
   * Width used by expanded Sidebars.
   * @defaultValue "17rem"
   */
  sidebarWidth?: string
}

/**
 * Provides shared Sidebar state, sizing, focus coordination, and optional keyboard control.
 *
 * @param props - Controlled or uncontrolled state, widths, shortcut configuration, and native wrapper properties.
 * @returns A context provider and shell wrapper for one coordinated Sidebar layout.
 */
function SidebarProvider({
  collapsedSidebarWidth = DEFAULT_SIDEBAR_COLLAPSED_WIDTH,
  defaultOpen = true,
  open: openProp,
  onOpenChange,
  keyboardShortcut,
  sidebarWidth = DEFAULT_SIDEBAR_WIDTH,
  className,
  style,
  children,
  ...props
}: SidebarProviderProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen)
  const portalContainerRef = React.useRef<HTMLDivElement>(null)
  const lastTriggerRef = React.useRef<HTMLElement>(null)
  const open = openProp ?? uncontrolledOpen

  /**
   * Resolves and publishes a controlled or uncontrolled Sidebar visibility update.
   *
   * @param value - The next visibility or a function deriving it from current state.
   * @returns Nothing; provider state and the change callback are updated.
   */
  const setOpen = React.useCallback<React.Dispatch<React.SetStateAction<boolean>>>(
    (value) => {
      const nextOpen = typeof value === "function" ? value(open) : value

      if (openProp === undefined) {
        setUncontrolledOpen(nextOpen)
      }

      onOpenChange?.(nextOpen)
    },
    [onOpenChange, open, openProp],
  )

  /**
   * Reverses the current Sidebar visibility state.
   *
   * @returns Nothing; the provider receives the opposite visibility state.
   */
  const toggleSidebar = React.useCallback(() => {
    setOpen((currentOpen) => !currentOpen)
  }, [setOpen])

  const shortcutKey = keyboardShortcut?.key
  const shortcutModifier = keyboardShortcut?.modifier
  const shortcutAltKey = Boolean(keyboardShortcut?.altKey)
  const shortcutShiftKey = Boolean(keyboardShortcut?.shiftKey)
  const shortcutPreventsDefault = keyboardShortcut?.preventDefault !== false

  React.useEffect(() => {
    if (!shortcutKey) return

    /**
     * Toggles the Sidebar when an event exactly matches the configured shortcut.
     *
     * @param event - The global keyboard event being evaluated.
     * @returns Nothing; a matching event may be prevented and toggle the provider.
     */
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return
      if (handledShortcutEvents.has(event)) return
      if (shortcutModifier === undefined && isEditableShortcutTarget(event)) return

      const keyMatches = matchesShortcutKey(event, shortcutKey, shortcutAltKey)
      const modifierMatches = matchesShortcutModifier(event, shortcutModifier)
      const altKeyMatches = event.altKey === shortcutAltKey
      const shiftKeyMatches = event.shiftKey === shortcutShiftKey
      const shortcutMatches =
        keyMatches && modifierMatches && altKeyMatches && shiftKeyMatches

      if (!shortcutMatches) return

      handledShortcutEvents.add(event)
      if (shortcutPreventsDefault) event.preventDefault()
      toggleSidebar()
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [
    shortcutAltKey,
    shortcutKey,
    shortcutModifier,
    shortcutPreventsDefault,
    shortcutShiftKey,
    toggleSidebar,
  ])

  const contextValue = React.useMemo<SidebarContextValue>(
    () => ({
      state: open ? "expanded" : "collapsed",
      open,
      setOpen,
      toggleSidebar,
      portalContainerRef,
      lastTriggerRef,
    }),
    [open, setOpen, toggleSidebar],
  )

  return (
    <SidebarContext.Provider value={contextValue}>
      <div
        ref={portalContainerRef}
        data-slot="sidebar-wrapper"
        style={
          {
            "--nessa-sidebar-width": sidebarWidth,
            "--nessa-sidebar-width-icon": collapsedSidebarWidth,
            ...style,
          } as React.CSSProperties
        }
        className={cn(
          "group/sidebar-wrapper flex min-h-svh w-full bg-background font-sans text-foreground",
          "md:has-data-[variant=inset]:bg-sidebar",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  )
}

export {
  SidebarProvider,
  useIsMobile,
  useSidebar,
  type SidebarKeyboardShortcut,
  type SidebarProviderProps,
  type SidebarShortcutModifier,
}
