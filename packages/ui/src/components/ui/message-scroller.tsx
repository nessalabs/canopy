"use client"

import * as React from "react"
import { ChevronDown } from "lucide-react"

import { cn } from "@/lib/utils"

interface MessageScrollerContextValue {
  pinned: boolean
  pinnedRef: React.RefObject<boolean>
  returningRef: React.RefObject<boolean>
  setPinned: (pinned: boolean) => void
  viewportRef: React.RefObject<HTMLDivElement | null>
  scrollToEnd: (behavior?: ScrollBehavior) => void
}

const MessageScrollerContext =
  React.createContext<MessageScrollerContextValue | null>(null)

function useMessageScrollerContext(consumer: string) {
  const context = React.useContext(MessageScrollerContext)
  if (!context) {
    throw new Error(`${consumer} must be used within a MessageScroller.`)
  }
  return context
}

export interface MessageScrollerState {
  /** Whether the reader is at the live edge and following new content. */
  pinned: boolean
  /** Scrolls the viewport to the newest content. */
  scrollToEnd: (behavior?: ScrollBehavior) => void
}

/** Host access to the surrounding MessageScroller's live-edge state. */
export function useMessageScroller(): MessageScrollerState {
  const { pinned, scrollToEnd } = useMessageScrollerContext(
    "useMessageScroller",
  )
  return React.useMemo(() => ({ pinned, scrollToEnd }), [pinned, scrollToEnd])
}

export interface MessageScrollerProps extends React.ComponentProps<"div"> {}

/**
 * The frame around a scrolling transcript. Owns the live-edge state shared by
 * its viewport and controls; the host sets the frame's height.
 */
function MessageScroller({ className, ...props }: MessageScrollerProps) {
  const [pinned, setPinnedState] = React.useState(true)
  const pinnedRef = React.useRef(true)
  // While true, a scrollToEnd is in flight: the viewport chases the live
  // edge even as it keeps growing, and being short of it does not release.
  const returningRef = React.useRef(false)
  const viewportRef = React.useRef<HTMLDivElement | null>(null)

  const setPinned = React.useCallback((value: boolean) => {
    if (pinnedRef.current === value) return
    pinnedRef.current = value
    setPinnedState(value)
  }, [])

  const scrollToEnd = React.useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const viewport = viewportRef.current
      if (!viewport) return
      returningRef.current = true
      viewport.scrollTo({ top: viewport.scrollHeight, behavior })
    },
    [],
  )

  const context = React.useMemo(
    () => ({
      pinned,
      pinnedRef,
      returningRef,
      setPinned,
      viewportRef,
      scrollToEnd,
    }),
    [pinned, scrollToEnd, setPinned],
  )

  return (
    <MessageScrollerContext.Provider value={context}>
      <div
        data-slot="message-scroller"
        data-pinned={pinned ? "true" : "false"}
        className={cn(
          "relative flex min-h-0 w-full max-w-full flex-col font-sans",
          className,
        )}
        {...props}
      />
    </MessageScrollerContext.Provider>
  )
}

/** A reader is "at the end" within this many CSS pixels of the live edge. */
const livePixelSlack = 4

export interface MessageScrollerViewportProps
  extends React.ComponentProps<"div"> {
  /**
   * Follows content growth while the reader stays at the live edge and opens
   * scrolled to the end. Any scroll away from the edge releases the follow
   * until the reader returns. Defaults to `true`.
   */
  autoScroll?: boolean
}

/**
 * The scrollable element. Its first child should be MessageScrollerContent.
 * Focusable by default so keyboard readers can scroll the transcript; hosts
 * may name the tab stop itself with `aria-label`.
 */
function MessageScrollerViewport({
  autoScroll = true,
  className,
  onScroll,
  ...props
}: MessageScrollerViewportProps) {
  const { pinnedRef, returningRef, setPinned, viewportRef } =
    useMessageScrollerContext("MessageScrollerViewport")
  const lastScrollTopRef = React.useRef(0)

  const updatePinned = React.useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const atEnd =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <=
      livePixelSlack
    if (atEnd) {
      returningRef.current = false
      setPinned(true)
    } else if (
      returningRef.current &&
      viewport.scrollTop < lastScrollTopRef.current - 1
    ) {
      // A return animation only moves downward, so an upward move during one
      // can only be the reader: cancel the return instead of dragging them.
      returningRef.current = false
      setPinned(false)
    } else if (!returningRef.current) {
      // Short of the end during an in-flight return is not a release.
      setPinned(false)
    }
    lastScrollTopRef.current = viewport.scrollTop
  }, [returningRef, setPinned, viewportRef])

  React.useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    if (autoScroll) viewport.scrollTop = viewport.scrollHeight
    updatePinned()
    const observer = new ResizeObserver(() => {
      if (viewport.scrollTop < lastScrollTopRef.current - 1) {
        // The reader moved upward between scroll events; releasing here keeps
        // a fast stream from yanking the gesture back to the bottom.
        returningRef.current = false
        setPinned(false)
      } else if (autoScroll && pinnedRef.current) {
        viewport.scrollTop = viewport.scrollHeight
      } else if (returningRef.current) {
        // Content grew mid-return: retarget the animation at the new end.
        viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" })
      }
      updatePinned()
    })
    observer.observe(viewport)
    const content = viewport.firstElementChild
    if (content) observer.observe(content)
    return () => observer.disconnect()
  }, [autoScroll, pinnedRef, returningRef, setPinned, updatePinned, viewportRef])

  return (
    <div
      ref={viewportRef}
      data-slot="message-scroller-viewport"
      tabIndex={0}
      className={cn(
        "min-h-0 w-full flex-1 overflow-y-auto overscroll-contain outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className,
      )}
      onScroll={(event) => {
        updatePinned()
        onScroll?.(event)
      }}
      {...props}
    />
  )
}

export interface MessageScrollerContentProps
  extends React.ComponentProps<"div"> {}

/**
 * The transcript container. Defaults to a polite `log` live region so newly
 * streamed rows are announced; hosts supply the accessible name.
 */
function MessageScrollerContent({
  className,
  ...props
}: MessageScrollerContentProps) {
  return (
    <div
      role="log"
      data-slot="message-scroller-content"
      className={cn("flex w-full flex-col gap-4", className)}
      {...props}
    />
  )
}

export interface MessageScrollerButtonProps
  extends React.ComponentProps<"button"> {}

/**
 * The scroll-to-latest control. It floats over the viewport's bottom edge,
 * appears once the reader leaves the live edge, and returns them to it.
 */
function MessageScrollerButton({
  className,
  onClick,
  children,
  ref,
  ...props
}: MessageScrollerButtonProps) {
  const { pinned, scrollToEnd, viewportRef } = useMessageScrollerContext(
    "MessageScrollerButton",
  )
  const localRef = React.useRef<HTMLButtonElement | null>(null)
  const setRef = React.useCallback(
    (node: HTMLButtonElement | null) => {
      localRef.current = node
      if (typeof ref === "function") ref(node)
      else if (ref) ref.current = node
    },
    [ref],
  )

  React.useEffect(() => {
    if (!pinned) return
    const button = localRef.current
    // Re-pinning hides the button; focus left on a hidden control would
    // strand keyboard and screen-reader users, so hand it to the viewport.
    if (button && button.ownerDocument.activeElement === button) {
      viewportRef.current?.focus({ preventScroll: true })
    }
  }, [pinned, viewportRef])

  return (
    <button
      ref={setRef}
      type="button"
      data-slot="message-scroller-button"
      data-visible={pinned ? "false" : "true"}
      aria-label="Scroll to latest messages"
      aria-hidden={pinned || undefined}
      tabIndex={pinned ? -1 : 0}
      onClick={(event) => {
        scrollToEnd()
        onClick?.(event)
      }}
      className={cn(
        "absolute inset-x-0 bottom-3 z-10 mx-auto inline-flex size-8 items-center justify-center rounded-full border border-border bg-popover text-popover-foreground shadow-md outline-none transition-[opacity,translate,background-color] hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none [&_svg]:size-4",
        pinned && "pointer-events-none translate-y-1 opacity-0",
        className,
      )}
      {...props}
    >
      {children ?? <ChevronDown aria-hidden="true" />}
    </button>
  )
}

export {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerViewport,
}
