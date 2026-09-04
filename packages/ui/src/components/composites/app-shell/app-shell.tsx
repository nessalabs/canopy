import * as React from "react"

import { cn } from "@/lib/utils"
import {
  closePane,
  createAppShellLayout,
  focusPane,
  maximizePane,
  movePane,
  normalizeAppShellLayout,
  openView,
  resetPaneSizes,
  resizeDock,
  restorePane,
  setDockOpen,
  splitPane,
  swapPanes,
  toggleDock,
  type AppShellDockSide,
  type AppShellLayout,
  type LayoutNode,
  type LayoutNodeId,
  type MovePaneOptions,
  type PaneSplitDirection,
  type PaneViewId,
} from "@/lib/app-shell-layout"

/** Primary modifier choices supported by the maximize keyboard shortcut. */
type AppShellShortcutModifier = "control" | "meta" | "mod"

/** Describes one exact keyboard shortcut for toggling pane maximize. */
interface AppShellKeyboardShortcut {
  /** KeyboardEvent key, matched without case sensitivity. */
  key: string
  /**
   * Primary modifier. `mod` accepts exactly one of Meta or Control; omit
   * for neither.
   * @defaultValue undefined
   */
  modifier?: AppShellShortcutModifier
  /**
   * Whether Alt must be pressed.
   * @defaultValue false
   */
  altKey?: boolean
  /**
   * Whether Shift must be pressed.
   * @defaultValue false
   */
  shiftKey?: boolean
  /**
   * Prevents the matched browser event by default. Set false to keep it.
   * @defaultValue true
   */
  preventDefault?: boolean
}

/** The out-of-the-box maximize shortcut: Shift+Escape, as in Zed. */
const DEFAULT_MAXIMIZE_SHORTCUT: AppShellKeyboardShortcut = Object.freeze({
  key: "Escape",
  shiftKey: true,
})

/** Keyboard events already claimed by one shell's shortcut handler. */
const handledShortcutEvents = new WeakSet<KeyboardEvent>()

/**
 * Checks whether a keyboard event carries exactly the requested primary
 * modifier (Control / Meta), and no unrequested one.
 *
 * @param event - The keyboard event being checked.
 * @param modifier - The required primary modifier, or undefined for none.
 * @returns Whether the event satisfies the requested modifier.
 */
function matchesShortcutModifier(
  event: KeyboardEvent,
  modifier: AppShellShortcutModifier | undefined,
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

/**
 * Checks whether a keyboard event comes from a place where the user is
 * typing text, so plain single-character shortcuts never steal keystrokes.
 *
 * @param event - The keyboard event being checked.
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

/** Operations that can produce a layout change. */
type AppShellLayoutOperation =
  | "pane-resize"
  | "dock-resize"
  | "dock-toggle"
  | "split"
  | "close"
  | "move"
  | "swap"
  | "open-view"
  | "focus"
  | "maximize"
  | "restore"
  | "reset"
  | "set"

/** Context accompanying every AppShell layout notification. */
interface AppShellChangeMeta {
  /** The operation that produced the change. */
  operation: AppShellLayoutOperation
  /**
   * Whether the change is a live step of an ongoing gesture or a settled
   * result. Persist settled layouts; live layouts fire on every pointer move.
   */
  phase: "live" | "settled"
}

/** Shared state and the single mutation path for one AppShell. */
interface AppShellContextValue {
  /** The layout document currently rendered. */
  layout: AppShellLayout
  /** Applies a pure layout update and publishes the resulting document. */
  updateLayout: (
    updater: (layout: AppShellLayout) => AppShellLayout,
    meta: AppShellChangeMeta,
  ) => void
}

const AppShellContext = React.createContext<AppShellContextValue | null>(null)

/**
 * Reads the layout context of the nearest AppShell.
 *
 * @returns The current AppShell context value.
 * @throws When called outside an AppShell.
 */
function useAppShellContext(): AppShellContextValue {
  const context = React.useContext(AppShellContext)

  if (!context) {
    throw new Error("AppShell components must be used within an AppShell.")
  }

  return context
}

/**
 * Collects every node id in a workspace tree.
 *
 * @param node - The subtree root to walk.
 * @param ids - The accumulator receiving each id.
 * @returns The accumulator holding every node id.
 */
function collectNodeIds(node: LayoutNode, ids = new Set<string>()): Set<string> {
  ids.add(node.id)

  if (node.type === "split") {
    for (const child of node.children) {
      collectNodeIds(child, ids)
    }
  }

  return ids
}

/**
 * Derives the next generated pane id of the form "pane-N": one past the
 * highest generated number currently in the tree, so ids read sequentially
 * regardless of how many internal split nodes exist.
 *
 * @param layout - The current layout document.
 * @returns A pane id unused by any node in the workspace.
 */
function nextPaneId(layout: AppShellLayout): LayoutNodeId {
  const ids = collectNodeIds(layout.workspace.root)
  let highest = 0

  for (const id of ids) {
    const match = /^pane-(\d+)$/.exec(id)

    if (match) {
      highest = Math.max(highest, Number(match[1]))
    }
  }

  let index = highest + 1

  while (ids.has(`pane-${index}`) || ids.has(`split:pane-${index}`)) {
    index++
  }

  return `pane-${index}`
}

/** Values accepted by the `splitPane` action. */
interface SplitPaneActionOptions {
  /** The pane to split. Defaults to the active pane. */
  paneId?: LayoutNodeId
  /** Where the new pane lands relative to the split pane. */
  direction: PaneSplitDirection
  /** Views hosted by the new pane. */
  views?: readonly PaneViewId[]
  /** The view the new pane presents. Defaults to the first provided view. */
  activeViewId?: PaneViewId
  /** Unique id for the new pane. Defaults to a generated "pane-N" id. */
  newPaneId?: LayoutNodeId
}

/** Imperative layout actions bound to the nearest AppShell. */
interface UseAppShellResult {
  /** The layout document currently rendered. */
  layout: AppShellLayout
  /**
   * Splits a pane and focuses the new pane. Returns the new pane's id, or
   * null when the split was rejected (unknown target or duplicate id).
   */
  splitPane: (options: SplitPaneActionOptions) => LayoutNodeId | null
  /** Closes a pane. The last remaining pane never closes. */
  closePane: (options?: { paneId?: LayoutNodeId }) => void
  /** Moves a pane onto another pane's edge (or merges on Center). */
  movePane: (options: MovePaneOptions) => void
  /** Swaps two panes in place; the first keeps focus. */
  swapPanes: (options: { paneId: LayoutNodeId; withPaneId: LayoutNodeId }) => void
  /** Opens a view in a pane and focuses it. Defaults to the active pane. */
  openView: (options: { viewId: PaneViewId; paneId?: LayoutNodeId }) => void
  /** Focuses a pane. */
  focusPane: (options: { paneId: LayoutNodeId }) => void
  /** Maximizes a pane over the workspace. Defaults to the active pane. */
  maximizePane: (options?: { paneId?: LayoutNodeId }) => void
  /** Restores a maximized workspace. */
  restorePane: () => void
  /** Opens or closes one dock. */
  setDockOpen: (options: { side: AppShellDockSide; open: boolean }) => void
  /** Reverses one dock's visibility. */
  toggleDock: (options: { side: AppShellDockSide }) => void
  /** Resizes one dock in pixels. */
  resizeDock: (options: {
    side: AppShellDockSide
    size: number
    minSize?: number
    maxSize?: number
  }) => void
  /** Resets every split to evenly distributed weights. */
  resetPaneSizes: () => void
  /** Replaces the whole layout document, for example from persistence. */
  setLayout: (layout: AppShellLayout) => void
}

/**
 * Provides the layout document and imperative layout actions of the nearest
 * AppShell.
 *
 * @returns The current layout and settled layout actions.
 * @throws When called outside an AppShell.
 */
function useAppShell(): UseAppShellResult {
  const { layout, updateLayout } = useAppShellContext()

  const actions = React.useMemo(() => {
    /**
     * Applies one settled layout operation.
     *
     * @param operation - The operation label published with the change.
     * @param updater - The pure layout update to apply.
     */
    const settle = (
      operation: AppShellLayoutOperation,
      updater: (current: AppShellLayout) => AppShellLayout,
    ) => {
      updateLayout(updater, { operation, phase: "settled" })
    }

    return {
      splitPane: (options: SplitPaneActionOptions) => {
        let newPaneId: LayoutNodeId | null = null

        updateLayout(
          (current) => {
            const paneId = options.newPaneId ?? nextPaneId(current)
            const next = splitPane(current, {
              paneId: options.paneId ?? current.workspace.activePaneId,
              direction: options.direction,
              newPaneId: paneId,
              views: options.views,
              activeViewId: options.activeViewId,
            })

            newPaneId = next === current ? null : paneId

            return next
          },
          { operation: "split", phase: "settled" },
        )

        return newPaneId
      },
      closePane: (options?: { paneId?: LayoutNodeId }) =>
        settle("close", (current) =>
          closePane(current, {
            paneId: options?.paneId ?? current.workspace.activePaneId,
          }),
        ),
      movePane: (options: MovePaneOptions) =>
        settle("move", (current) => movePane(current, options)),
      swapPanes: (options: { paneId: LayoutNodeId; withPaneId: LayoutNodeId }) =>
        settle("swap", (current) => swapPanes(current, options)),
      openView: (options: { viewId: PaneViewId; paneId?: LayoutNodeId }) =>
        settle("open-view", (current) => openView(current, options)),
      focusPane: (options: { paneId: LayoutNodeId }) =>
        settle("focus", (current) => focusPane(current, options)),
      maximizePane: (options?: { paneId?: LayoutNodeId }) =>
        settle("maximize", (current) => maximizePane(current, options)),
      restorePane: () => settle("restore", restorePane),
      setDockOpen: (options: { side: AppShellDockSide; open: boolean }) =>
        settle("dock-toggle", (current) => setDockOpen(current, options)),
      toggleDock: (options: { side: AppShellDockSide }) =>
        settle("dock-toggle", (current) => toggleDock(current, options)),
      resizeDock: (options: {
        side: AppShellDockSide
        size: number
        minSize?: number
        maxSize?: number
      }) => settle("dock-resize", (current) => resizeDock(current, options)),
      resetPaneSizes: () => settle("reset", resetPaneSizes),
      setLayout: (next: AppShellLayout) =>
        settle("set", () => normalizeAppShellLayout(next)),
    }
  }, [updateLayout])

  return React.useMemo(
    () => ({ layout, ...actions }),
    [actions, layout],
  )
}

/** Properties accepted by the AppShell root. */
interface AppShellProps extends React.ComponentProps<"div"> {
  /**
   * The layout document when the shell is controlled by its consumer.
   * Interactions report documents through `onLayoutChange`; the consumer
   * renders them back through this property.
   */
  layout?: AppShellLayout
  /**
   * Initial layout for an uncontrolled shell.
   * @defaultValue createAppShellLayout()
   */
  defaultLayout?: AppShellLayout
  /**
   * Called with the next document on every step of an interaction, including
   * each pointer move of a resize. Persist from `onLayoutCommit` instead.
   */
  onLayoutChange?: (layout: AppShellLayout, meta: AppShellChangeMeta) => void
  /** Called once per settled operation with the resulting document. */
  onLayoutCommit?: (layout: AppShellLayout, meta: AppShellChangeMeta) => void
  /**
   * Keyboard shortcut that toggles maximize on the active pane. Pass a
   * shortcut description to override it, or false to turn it off.
   * @defaultValue Shift+Escape
   */
  maximizeShortcut?: AppShellKeyboardShortcut | false
}

/**
 * Provides the application-shell frame: a full-height column that hosts the
 * header, body (docks plus workspace), and status bar, and coordinates one
 * shared layout document.
 *
 * The shell owns presentation only. Persistence belongs to the consuming
 * application: read documents from `onLayoutCommit` and supply them back via
 * `layout` or `defaultLayout`.
 *
 * @param props - Controlled or uncontrolled layout, change callbacks, and
 * native container properties.
 * @returns A context provider and the shell's outer frame.
 */
function AppShell({
  layout: layoutProp,
  defaultLayout,
  onLayoutChange,
  onLayoutCommit,
  maximizeShortcut = DEFAULT_MAXIMIZE_SHORTCUT,
  className,
  children,
  ref,
  ...props
}: AppShellProps) {
  const [fallbackLayout] = React.useState(() =>
    createAppShellLayout(),
  )
  const [internalLayout, setInternalLayout] = React.useState<
    AppShellLayout | undefined
  >(defaultLayout)

  const providedLayout = layoutProp ?? internalLayout ?? fallbackLayout
  // Provided documents (persisted, hand-built, or migrated) are normalized
  // before rendering so healed pointers and tree invariants always hold.
  const layout = React.useMemo(
    () => normalizeAppShellLayout(providedLayout),
    [providedLayout],
  )
  const layoutRef = React.useRef(layout)
  layoutRef.current = layout
  const lastCommittedRef = React.useRef(layout)
  const rootRef = React.useRef<HTMLDivElement>(null)
  // Serves both our shortcut-scoping ref and a consumer's ref; memoized so
  // React does not detach and re-attach refs on every render.
  const composedRootRef = React.useMemo(
    () => (element: HTMLDivElement | null) => {
      rootRef.current = element
      if (typeof ref === "function") ref(element)
      else if (ref) ref.current = element
    },
    [ref],
  )

  const controlled = layoutProp !== undefined

  const updateLayout = React.useCallback<AppShellContextValue["updateLayout"]>(
    (updater, meta) => {
      const current = layoutRef.current
      const next = updater(current)

      if (next !== current) {
        layoutRef.current = next

        if (!controlled) {
          setInternalLayout(next)
        }

        onLayoutChange?.(next, meta)
      }

      // A settled operation commits only when the document differs from the
      // last committed one, so no-op operations produce no phantom commits
      // while gesture-ending calls still deliver the final document.
      if (meta.phase === "settled" && next !== lastCommittedRef.current) {
        lastCommittedRef.current = next
        onLayoutCommit?.(next, meta)
      }
    },
    [controlled, onLayoutChange, onLayoutCommit],
  )

  const shortcut = maximizeShortcut === false ? undefined : maximizeShortcut
  const shortcutKey = shortcut?.key
  const shortcutModifier = shortcut?.modifier
  const shortcutAltKey = Boolean(shortcut?.altKey)
  const shortcutShiftKey = Boolean(shortcut?.shiftKey)
  const shortcutPreventsDefault = shortcut?.preventDefault !== false

  React.useEffect(() => {
    if (!shortcutKey) return

    /**
     * Toggles maximize on the active pane when the pressed keys exactly
     * match the configured shortcut.
     *
     * @param event - The global keyboard event being checked.
     */
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return
      if (handledShortcutEvents.has(event)) return
      // A bare single-character shortcut must not fire while the user is
      // typing in a text field. Named keys such as Escape are always safe.
      if (
        shortcutModifier === undefined &&
        shortcutKey.length === 1 &&
        isEditableShortcutTarget(event)
      ) {
        return
      }
      // Only this shell's own keystrokes count, so two shells on one page
      // never fight over the shortcut. When nothing is focused (the event
      // lands on the page body), the first shell handles it.
      const root = rootRef.current
      const target = event.target
      const insideShell =
        root !== null && target instanceof Node && root.contains(target)
      const nothingFocused =
        !(target instanceof HTMLElement) ||
        target === target.ownerDocument.body ||
        target === target.ownerDocument.documentElement

      if (!insideShell && !nothingFocused) return

      const matches =
        event.key.toLowerCase() === shortcutKey.toLowerCase() &&
        matchesShortcutModifier(event, shortcutModifier) &&
        event.altKey === shortcutAltKey &&
        event.shiftKey === shortcutShiftKey

      if (!matches) return

      handledShortcutEvents.add(event)
      if (shortcutPreventsDefault) event.preventDefault()

      const maximized =
        layoutRef.current.workspace.maximizedPaneId !== undefined

      updateLayout(
        (current) =>
          maximized ? restorePane(current) : maximizePane(current, {}),
        { operation: maximized ? "restore" : "maximize", phase: "settled" },
      )
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [
    shortcutAltKey,
    shortcutKey,
    shortcutModifier,
    shortcutPreventsDefault,
    shortcutShiftKey,
    updateLayout,
  ])

  const contextValue = React.useMemo<AppShellContextValue>(
    () => ({ layout, updateLayout }),
    [layout, updateLayout],
  )

  return (
    <AppShellContext.Provider value={contextValue}>
      {/* Consumer props spread first so the attributes the shell owns
          (slot, ref) always win. */}
      <div
        {...props}
        ref={composedRootRef}
        data-slot="app-shell"
        className={cn(
          "flex h-full min-h-0 w-full flex-col overflow-hidden bg-background font-sans text-foreground",
          className,
        )}
      >
        {children}
      </div>
    </AppShellContext.Provider>
  )
}

export {
  AppShell,
  useAppShell,
  useAppShellContext,
  type AppShellChangeMeta,
  type AppShellContextValue,
  type AppShellKeyboardShortcut,
  type AppShellLayoutOperation,
  type AppShellProps,
  type AppShellShortcutModifier,
  type SplitPaneActionOptions,
  type UseAppShellResult,
}
