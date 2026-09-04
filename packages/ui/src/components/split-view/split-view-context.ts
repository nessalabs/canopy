import * as React from "react"

import type { SplitViewOrientation } from "./split-view-options"
import type {
  SplitViewLayout,
  SplitViewPanelConstraints,
  SplitViewSize,
} from "./split-view-math"

/** Sizing constraints a panel declares in authored units. */
interface SplitViewPanelSizeProps {
  /**
   * Smallest expanded size: a percentage number, "Npx", or "N%".
   * @defaultValue 0
   */
  minSize?: SplitViewSize
  /**
   * Largest size: a percentage number, "Npx", or "N%".
   * @defaultValue 100
   */
  maxSize?: SplitViewSize
  /** Preferred initial size: a percentage number, "Npx", or "N%". */
  defaultSize?: SplitViewSize
  /**
   * Size presented while collapsed: a percentage number, "Npx", or "N%".
   * @defaultValue 0
   */
  collapsedSize?: SplitViewSize
  /**
   * Whether the panel snaps closed below its minimum size.
   * @defaultValue false
   */
  collapsible?: boolean
}

/** A panel registered with its owning SplitView. */
interface RegisteredSplitViewPanel {
  /** The panel's unique id within the group. */
  id: string
  /** The panel's rendered element, used for ordering and measurement. */
  element: HTMLElement
  /** The panel's authored sizing constraints. */
  constraints: SplitViewPanelSizeProps
}

/** ARIA values presented by one separator. */
interface SplitViewSeparatorAria {
  /** The id of the panel the separator controls. */
  controls: string
  /** The controlled panel's current percentage size. */
  valueNow: number | undefined
  /** The smallest reachable percentage size. */
  valueMin: number
  /** The largest reachable percentage size. */
  valueMax: number
}

/** Shared state and interaction handlers provided by one SplitView. */
interface SplitViewContextValue {
  /** The axis along which the group lays out its panels. */
  orientation: SplitViewOrientation
  /** The validated layout currently rendered, keyed by panel id. */
  layout: SplitViewLayout
  /** Percentage-resolved constraints, in panel order. */
  derivedConstraints: readonly SplitViewPanelConstraints[]
  /** Panel ids in visual order. */
  panelIds: readonly string[]
  /** The separator currently driving a pointer resize, if any. */
  activeSeparatorId: string | null
  /** Registers a panel; returns its disposer. */
  registerPanel: (panel: RegisteredSplitViewPanel) => () => void
  /** Registers a separator element; returns its disposer. */
  registerSeparator: (id: string, element: HTMLElement) => () => void
  /** Computes the ARIA values for a registered separator. */
  getSeparatorAria: (separatorId: string) => SplitViewSeparatorAria | undefined
  /** Begins a pointer-driven resize from a separator. */
  onSeparatorPointerDown: (
    separatorId: string,
    event: React.PointerEvent<HTMLElement>,
  ) => void
  /** Continues an active pointer-driven resize. */
  onSeparatorPointerMove: (
    separatorId: string,
    event: React.PointerEvent<HTMLElement>,
  ) => void
  /** Settles or cancels an active pointer-driven resize. */
  onSeparatorPointerEnd: (
    separatorId: string,
    event: React.PointerEvent<HTMLElement>,
  ) => void
  /** Applies keyboard resize commands from a separator. */
  onSeparatorKeyDown: (
    separatorId: string,
    event: React.KeyboardEvent<HTMLElement>,
  ) => void
}

const SplitViewContext = React.createContext<SplitViewContextValue | null>(null)

/**
 * Reads the coordination state of the nearest SplitView.
 *
 * @returns The current SplitView context value.
 * @throws When called outside a SplitView.
 */
function useSplitView(): SplitViewContextValue {
  const context = React.useContext(SplitViewContext)

  if (!context) {
    throw new Error(
      "SplitView panels and separators must be used within a SplitView.",
    )
  }

  return context
}

/**
 * Builds one ref callback that feeds an element to our internal ref and to
 * a ref the consumer may have passed, so neither side loses it.
 *
 * @param internal - The component's own element ref.
 * @param forwarded - The consumer's ref, if any.
 * @returns A ref callback serving both.
 */
function composeRefs<Element>(
  internal: React.RefObject<Element | null>,
  forwarded: React.Ref<Element> | undefined,
): React.RefCallback<Element> {
  return (element) => {
    internal.current = element

    if (typeof forwarded === "function") {
      forwarded(element)
    } else if (forwarded) {
      forwarded.current = element
    }
  }
}

/**
 * Orders registered elements by their position in the document, so panel and
 * separator order always matches what the user sees regardless of mount
 * order.
 *
 * @param entries - The registered entries to order.
 * @param getElement - Reads the element from one entry.
 * @returns The entries sorted in document order.
 */
function sortByDocumentPosition<Entry>(
  entries: readonly Entry[],
  getElement: (entry: Entry) => HTMLElement,
): Entry[] {
  return [...entries].sort((a, b) => {
    const position = getElement(a).compareDocumentPosition(getElement(b))

    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1
    return 0
  })
}

export {
  SplitViewContext,
  composeRefs,
  sortByDocumentPosition,
  useSplitView,
  type RegisteredSplitViewPanel,
  type SplitViewContextValue,
  type SplitViewPanelSizeProps,
  type SplitViewSeparatorAria,
}
