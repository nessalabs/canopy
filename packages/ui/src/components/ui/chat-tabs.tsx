import * as React from "react"
import { Plus, X } from "lucide-react"

import { cn } from "@/lib/utils"

const chatTabsFocusClassName =
  "outline-none focus-visible:[outline-style:solid] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"

export interface ChatTabItem {
  id: string
  title: string
  /** A leading glyph; the tab owns its size and color. */
  icon?: React.ReactNode
  /** Shows the close control and lets `onClose` remove the tab. */
  closeable?: boolean
  /** Shows the glowing activity dot after the title. */
  loading?: boolean
  /**
   * Shows the attention badge after the title — pending approvals, unread
   * replies. Values above 1 render the number; 1 renders a plain dot.
   */
  badgeCount?: number
}

export interface ChatTabsProps
  extends React.ComponentProps<"div"> {
  tabs: readonly ChatTabItem[]
  /** The selected tab's id. */
  /** The selected tab, or `null` when no tab is selected. */
  value: string | null
  /** Fires with the newly selected tab id. */
  onValueChange: (value: string) => void
  /** Enables each closeable tab's close control. */
  onClose?: (id: string) => void
  /** Renders the trailing new-tab control. */
  onNew?: () => void
  /** The accessible name of the new-tab control. */
  newTabLabel?: string
  /** The accessible name announced for the tab list. */
  label?: string
  /** Pinned after the new-tab control, outside the scrolling track. */
  trailing?: React.ReactNode
}

/**
 * The floating chat window's tab strip: pill tabs on a horizontally
 * scrolling tablist, the active tab washed and outlined in the chat
 * accent, a glowing dot for busy tabs, an attention badge for tabs that
 * need the user, a close control on closeable tabs, and a
 * trailing new-tab button. Arrow keys, Home, and End rove the tablist and
 * Delete closes a closeable tab (the ✕ is a pointer-only affordance, since
 * a tablist may own nothing but tabs); a panel host labels itself with
 * `chat-tab-panel-<id>` to pair with a tab's `aria-controls`.
 */
function ChatTabs({
  tabs,
  value,
  onValueChange,
  onClose,
  onNew,
  newTabLabel = "New tab",
  label = "Chat tabs",
  trailing,
  className,
  ...props
}: ChatTabsProps) {
  const tabRefs = React.useRef(new Map<string, HTMLButtonElement>())
  // Roving tabindex needs one focusable stop even when `value` matches no
  // tab (the type allows null, and hosts may close the active tab without
  // reselecting) — the first tab takes it as a fallback.
  const hasActiveTab = tabs.some((tab) => tab.id === value)

  const selectRelativeTab = (index: number, key: string) => {
    if (tabs.length === 0) return
    const nextIndex =
      key === "Home"
        ? 0
        : key === "End"
          ? tabs.length - 1
          : (index + (key === "ArrowLeft" ? -1 : 1) + tabs.length) % tabs.length
    const next = tabs[nextIndex]
    if (!next) return
    onValueChange(next.id)
    tabRefs.current.get(next.id)?.focus()
  }

  return (
    <div
      data-slot="chat-tabs"
      className={cn("flex min-w-0 items-center gap-2 font-sans", className)}
      {...props}
    >
      <div
        data-slot="chat-tabs-track"
        role="tablist"
        aria-label={label}
        className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [overscroll-behavior-x:contain] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab, index) => {
          const active = tab.id === value
          const badgeCount = Math.max(0, tab.badgeCount ?? 0)
          return (
            <span
              key={tab.id}
              role="presentation"
              data-slot="chat-tab"
              data-active={active || undefined}
              className={cn(
                "relative inline-flex max-w-56 shrink-0 items-center rounded-full border transition-[background-color,border-color] [transition-duration:var(--nessa-motion-duration-fast)] [transition-timing-function:var(--nessa-motion-easing-standard)] motion-reduce:transition-none",
                active
                  ? "border-(--nessa-chat-accent)/45 bg-(--nessa-chat-accent)/10"
                  : cn(
                      // The whole pill — title and close together — takes
                      // the hover wash as one control.
                      "hover:bg-accent",
                      badgeCount > 0
                        ? "border-destructive/60"
                        : "border-transparent",
                    ),
              )}
            >
              <button
                ref={(node) => {
                  if (node) tabRefs.current.set(tab.id, node)
                  else tabRefs.current.delete(tab.id)
                }}
                type="button"
                role="tab"
                id={`chat-tab-${tab.id}`}
                aria-selected={active}
                aria-busy={tab.loading || undefined}
                aria-controls={`chat-tab-panel-${tab.id}`}
                tabIndex={active || (!hasActiveTab && index === 0) ? 0 : -1}
                aria-label={tab.title}
                title={tab.title}
                onClick={() => onValueChange(tab.id)}
                onKeyDown={(event) => {
                  if (
                    ["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                      event.key,
                    )
                  ) {
                    event.preventDefault()
                    selectRelativeTab(index, event.key)
                    return
                  }
                  // The close affordance is pointer-only (a tablist may own
                  // nothing but tabs), so Delete is the accessible close.
                  // Focus hands to a successor once the tab is gone, instead
                  // of falling to the document body.
                  if (
                    (event.key === "Delete" || event.key === "Backspace") &&
                    tab.closeable &&
                    onClose
                  ) {
                    event.preventDefault()
                    const successorId = (tabs[index + 1] ?? tabs[index - 1])?.id
                    onClose(tab.id)
                    if (successorId !== undefined) {
                      setTimeout(() => {
                        tabRefs.current.get(successorId)?.focus()
                      }, 0)
                    }
                  }
                }}
                className={cn(
                  "inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-full border-0 bg-transparent py-1.5 pl-3 font-sans nessa-text-2 transition-colors [transition-duration:var(--nessa-motion-duration-fast)] [transition-timing-function:var(--nessa-motion-easing-standard)] motion-reduce:transition-none",
                  tab.closeable && onClose ? "pr-1" : "pr-3",
                  active
                    ? "font-semibold text-foreground"
                    : "font-medium text-muted-foreground",
                  chatTabsFocusClassName,
                )}
              >
                {tab.icon ? (
                  <span
                    aria-hidden="true"
                    className="flex shrink-0 items-center justify-center [&_svg]:size-3.5"
                  >
                    {tab.icon}
                  </span>
                ) : null}
                <span className="min-w-0 truncate">{tab.title}</span>
                {tab.loading ? (
                  <span
                    data-slot="chat-tab-loading"
                    aria-hidden="true"
                    className="size-[7px] shrink-0 rounded-full bg-(--nessa-chat-accent) shadow-[0_0_8px] shadow-(color:--nessa-chat-accent)/50"
                  />
                ) : null}
                {badgeCount > 0 ? (
                  <span
                    data-slot="chat-tab-badge"
                    aria-hidden="true"
                    className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-destructive px-1 nessa-text-1 font-bold leading-none text-white"
                  >
                    {badgeCount > 1 ? badgeCount : ""}
                  </span>
                ) : null}
              </button>
              {tab.closeable && onClose ? (
                <button
                  type="button"
                  data-slot="chat-tab-close"
                  aria-hidden="true"
                  tabIndex={-1}
                  title={`Close ${tab.title} (Delete)`}
                  onClick={() => onClose(tab.id)}
                  className="mr-1.5 inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-muted-foreground outline-none transition-colors [transition-duration:var(--nessa-motion-duration-fast)] [transition-timing-function:var(--nessa-motion-easing-standard)] hover:text-foreground motion-reduce:transition-none [&_svg]:size-3"
                >
                  <X aria-hidden="true" />
                </button>
              ) : null}
            </span>
          )
        })}
      </div>
      {onNew ? (
        <button
          type="button"
          data-slot="chat-tabs-new"
          aria-label={newTabLabel}
          title={newTabLabel}
          onClick={onNew}
          className={cn(
            "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-muted-foreground transition-colors [transition-duration:var(--nessa-motion-duration-fast)] [transition-timing-function:var(--nessa-motion-easing-standard)] hover:bg-accent hover:text-accent-foreground motion-reduce:transition-none [&_svg]:size-4",
            chatTabsFocusClassName,
          )}
        >
          <Plus aria-hidden="true" />
        </button>
      ) : null}
      {trailing ? (
        <div data-slot="chat-tabs-trailing" className="flex shrink-0 items-center">
          {trailing}
        </div>
      ) : null}
    </div>
  )
}

export { ChatTabs }
