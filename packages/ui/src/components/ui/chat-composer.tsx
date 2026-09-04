import * as React from "react"
import {
  ArrowUp,
  AtSign,
  Box,
  ClipboardType,
  LoaderCircle,
  Paperclip,
  Puzzle,
  X,
} from "lucide-react"
import { Popover } from "radix-ui"

import { cn } from "@/lib/utils"

import {
  FileDropZone,
  fileDropZoneDefaultLabel,
  type FileDropZoneProps,
} from "./file-drop-zone"

/**
 * The editing-surface operations a ChatComposerTrigger needs, implemented by
 * both the plain textarea input and the chip-capable editor so triggers work
 * against either without knowing which is mounted.
 */
export interface ChatComposerInputAdapter {
  /** The focusable editing element that trigger listeners attach to. */
  element: HTMLElement
  /** Reads the trigger token under the collapsed caret; `key` is stable for one token anchor. */
  readToken: (trigger: string) => { key: string; query: string } | null
  /** Returns whether the trigger sequence still sits at a previously read token key. */
  hasTokenAnchor: (trigger: string, key: string) => boolean
  /** Removes the active token (trigger sequence plus query) and inserts `replaceWith`. */
  replaceToken: (trigger: string, replaceWith: string) => void
  /** Inserts text at the caret, replacing any selection. */
  insertText: (text: string) => void
  /** Deletes the selection, or one character before the caret. */
  deleteBackward: () => void
}

interface ChatComposerContextValue {
  composerMaxHeight: React.CSSProperties["maxHeight"] | undefined
  constrained: boolean
  submitOnEnter: boolean
  size: "default" | "compact"
  inputAdapter: ChatComposerInputAdapter | null
  registerInput: (adapter: ChatComposerInputAdapter | null) => void
}

export const ChatComposerContext =
  React.createContext<ChatComposerContextValue>({
    composerMaxHeight: undefined,
    constrained: false,
    submitOnEnter: true,
    size: "default",
    inputAdapter: null,
    registerInput: () => undefined,
  })

export type ChatComposerBorderMode = "none" | "focus" | "always"

/**
 * The drop behavior a composer delegates to FileDropZone: the zone's own
 * options, and nothing else — the element it merges onto, the overlay, and
 * every DOM prop belong to the composer's form, which the composer owns.
 * `onFiles` receives the files a person dropped anywhere over the
 * composer, already filtered by `accept`, `maxSize`, and `maxFiles`.
 */
export type ChatComposerFileDrop = Pick<
  FileDropZoneProps,
  | "onFiles"
  | "onRejectedFiles"
  | "label"
  | "accept"
  | "multiple"
  | "maxFiles"
  | "maxSize"
  | "directories"
  | "disabled"
>

/** A compound message-entry form with independently composable input and footer controls. */
export interface ChatComposerProps extends React.ComponentProps<"form"> {
  /**
   * Controls when the root surface border is visible. Defaults to `none`.
   * A composer taking `fileDrop` still lights its border while a file drag
   * is over it, in every mode — that feedback belongs to the drag, not to
   * the resting chrome.
   */
  borderMode?: ChatComposerBorderMode
  /** Sets the preferred width in CSS pixels while preserving host containment. */
  width?: number
  /**
   * Caps the complete composer height in CSS pixels; the message input scrolls
   * within the cap. Values below the composer's intrinsic footer-safe height
   * clamp to that height, including when the footer wraps responsively.
   */
  maxHeight?: number
  submitOnEnter?: boolean
  size?: "default" | "compact"
  /**
   * Accepts dropped files anywhere over the composer — the input, the
   * attachment row, the footer — by merging a FileDropZone onto the
   * composer form itself, so the capability adds no element and no layout
   * of its own. While a file drag is over it the composer lights its
   * border the way focus does, and exposes `data-dragging` for hosts that
   * want a different treatment. Omit the prop and the composer takes no
   * drops at all. The composer stores nothing: hosts turn the files into
   * their own attachments and render them as `ChatComposerAttachment`
   * pills.
   *
   * Without the prop the composer attaches nothing, but still cancels
   * file drops over itself rather than letting the browser navigate away
   * from the page to the dropped file.
   *
   * Dropping is a pointer gesture with no keyboard equivalent, so a host
   * that takes drops owes its readers two things of its own: a focusable
   * attach control that reaches the same handler, and an announcement of
   * what the files became. The composer announces only the drag itself,
   * since it is the only part it can see.
   */
  fileDrop?: ChatComposerFileDrop
}

/** Stands in for the drop handler while a composer takes no drops. */
const noFiles = () => undefined

/** Renders the compound message-entry form and provides layout behavior to its slots. */
function ChatComposer({
  borderMode = "none",
  width,
  maxHeight,
  submitOnEnter = true,
  size = "default",
  fileDrop,
  className,
  children,
  style,
  ...props
}: ChatComposerProps) {
  const responsiveWidth =
    width === undefined ? undefined : `min(${width}px, 100%)`
  const requestedMaxHeight = maxHeight ?? style?.maxHeight
  const effectiveMaxHeight = requestedMaxHeight
  const [inputAdapter, setInputAdapter] =
    React.useState<ChatComposerInputAdapter | null>(null)

  const context = React.useMemo(
    () => ({
      composerMaxHeight: effectiveMaxHeight,
      constrained: effectiveMaxHeight !== undefined,
      submitOnEnter,
      size,
      inputAdapter,
      registerInput: setInputAdapter,
    }),
    [effectiveMaxHeight, inputAdapter, size, submitOnEnter],
  )

  const renderForm = (isDragging: boolean) => (
    <form
      data-slot="chat-composer"
      data-border-mode={borderMode}
      className={cn(
        "relative grid min-w-0 w-full max-w-full gap-3 rounded-3xl border border-transparent bg-card p-3 font-sans text-card-foreground shadow-sm transition-[border-color,box-shadow]",
        effectiveMaxHeight !== undefined &&
          "grid-rows-[minmax(0,1fr)_auto] overflow-hidden has-[[data-slot=chat-composer-attachments]]:grid-rows-[auto_minmax(0,1fr)_auto]",
        borderMode === "focus" &&
          "focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20",
        borderMode === "always" &&
          "border-border focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20",
        effectiveMaxHeight === undefined &&
          (size === "compact" ? "min-h-24" : "min-h-32"),
        size === "compact" && "gap-2 rounded-2xl p-2.5",
        // A file drag reads like focus: the surface it is aimed at lights
        // up. Hosts wanting another treatment style data-dragging instead.
        fileDrop &&
          "data-[dragging]:border-ring data-[dragging]:ring-[3px] data-[dragging]:ring-ring/20",
        className,
      )}
      style={{
        ...style,
        ...(responsiveWidth === undefined
          ? undefined
          : { width: responsiveWidth }),
        minHeight:
          effectiveMaxHeight === undefined
            ? style?.minHeight
            : "min-content",
        maxHeight: effectiveMaxHeight,
      }}
      {...props}
    >
      {children}
      {fileDrop ? (
        // Merged onto this form, the zone has no DOM of its own to speak
        // through, so the composer announces the drag it is showing.
        <span aria-live="polite" className="sr-only">
          {isDragging ? (fileDrop.label ?? fileDropZoneDefaultLabel) : ""}
        </span>
      ) : null}
    </form>
  )

  return (
    <ChatComposerContext.Provider value={context}>
      {/*
        asChild merges the drag protocol onto the form itself: a drop
        anywhere over the composer counts, and the composer keeps its own
        box, so nothing about its layout or sizing contract moves. The zone
        stays mounted even with no fileDrop — swapping the child's element
        type would remount the form and wipe a message someone is still
        typing — and simply refuses drops until a host asks for them.
      */}
      <FileDropZone
        asChild
        disabled={!fileDrop}
        onFiles={noFiles}
        {...fileDrop}
        data-disabled={fileDrop?.disabled || undefined}
      >
        {({ isDragging }) => renderForm(isDragging)}
      </FileDropZone>
    </ChatComposerContext.Provider>
  )
}

/** Submits the composer form through its first enabled submitter, matching Enter-to-send. */
export function requestComposerSubmit(form: HTMLFormElement | null) {
  if (!form) return
  const submitters = Array.from(
    form.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
      'button:not([type]), button[type="submit"], input[type="submit"], input[type="image"]',
    ),
  )
  const enabledSubmitter = submitters.find(
    (submitter) => !submitter.matches(":disabled"),
  )
  if (submitters.length > 0 && !enabledSubmitter) return
  form.requestSubmit(enabledSubmitter)
}

/**
 * Scans backwards from the caret for an active trigger token: the trigger
 * sequence at the start of the value or after whitespace, with no whitespace
 * between it and the caret. Shared by the textarea and editor adapters so
 * both editing surfaces agree on when a menu opens. The scan is bounded by
 * the word under the caret, not the value length.
 */
export function scanTriggerToken(
  value: string,
  caret: number,
  trigger: string,
): { start: number; query: string } | null {
  for (let index = caret - trigger.length; index >= 0; index -= 1) {
    if (
      value.startsWith(trigger, index) &&
      (index === 0 || /\s/.test(value[index - 1]!))
    ) {
      const query = value.slice(index + trigger.length, caret)
      // Multi-character triggers can pass the boundary test with whitespace
      // in the unscanned tail; a token never contains whitespace.
      return /\s/.test(query) ? null : { start: index, query }
    }
    if (/\s/.test(value[index]!)) return null
  }
  return null
}

/**
 * Replaces a textarea range through the DOM editing API and dispatches an
 * input event, so React's controlled onChange and testing-library value
 * tracking both observe the change.
 */
function replaceTextareaRange(
  element: HTMLTextAreaElement,
  start: number,
  end: number,
  replacement: string,
) {
  element.focus()
  element.setRangeText(replacement, start, end, "end")
  element.dispatchEvent(new Event("input", { bubbles: true }))
}

/** Reads the trigger token under a collapsed textarea caret. */
function readTextareaToken(element: HTMLTextAreaElement, trigger: string) {
  const caret = element.selectionStart ?? 0
  if (element.selectionEnd !== caret) return null
  return scanTriggerToken(element.value, caret, trigger)
}

/** Builds the trigger adapter over a plain textarea input. */
function createTextareaAdapter(
  element: HTMLTextAreaElement,
): ChatComposerInputAdapter {
  return {
    element,
    readToken: (trigger) => {
      const token = readTextareaToken(element, trigger)
      return token ? { key: String(token.start), query: token.query } : null
    },
    hasTokenAnchor: (trigger, key) =>
      element.value.startsWith(trigger, Number(key)),
    replaceToken: (trigger, replaceWith) => {
      const token = readTextareaToken(element, trigger)
      if (!token) return
      const caret = element.selectionStart ?? element.value.length
      replaceTextareaRange(
        element,
        token.start,
        Math.max(caret, token.start),
        replaceWith,
      )
    },
    insertText: (text) => {
      const start = element.selectionStart ?? element.value.length
      const end = element.selectionEnd ?? start
      replaceTextareaRange(element, start, end, text)
    },
    deleteBackward: () => {
      const start = element.selectionStart ?? 0
      const end = element.selectionEnd ?? start
      if (start === end && start > 0) {
        replaceTextareaRange(element, start - 1, end, "")
      } else if (start !== end) {
        replaceTextareaRange(element, start, end, "")
      } else {
        element.focus()
      }
    },
  }
}

export interface ChatComposerInputProps
  extends React.ComponentPropsWithRef<"textarea"> {
  /** Caps the textarea's own autosized height before it begins scrolling. */
  maxHeight?: number
  /**
   * Receives pasted plain text at least `pasteAttachmentMinLength` characters
   * long instead of inserting it into the textarea, so the host can present
   * it as an attachment. Shorter pastes insert normally. Omit to keep every
   * paste inline.
   */
  onPasteAttachment?: (text: string) => void
  /** The minimum pasted-text length that `onPasteAttachment` captures. Defaults to 500. */
  pasteAttachmentMinLength?: number
}

/** Renders the autosizing plain-text message input owned by a ChatComposer. */
function ChatComposerInput({
  className,
  maxHeight = 240,
  onChange,
  onKeyDown,
  onPaste,
  onPasteAttachment,
  pasteAttachmentMinLength = 500,
  ref: forwardedRef,
  ...props
}: ChatComposerInputProps) {
  const { composerMaxHeight, constrained, registerInput, size, submitOnEnter } =
    React.useContext(ChatComposerContext)
  const localRef = React.useRef<HTMLTextAreaElement | null>(null)
  const setRef = React.useCallback(
    (node: HTMLTextAreaElement | null) => {
      localRef.current = node
      if (typeof forwardedRef === "function") forwardedRef(node)
      else if (forwardedRef) forwardedRef.current = node
    },
    [forwardedRef],
  )

  // The adapter registers in a layout effect keyed on mount, never in the
  // ref callback: a host passing an inline callback ref re-creates the ref
  // identity every render, and registering there would push a fresh adapter
  // into composer state each time — re-rendering every context consumer and,
  // at worst, looping ("maximum update depth exceeded").
  React.useLayoutEffect(() => {
    const node = localRef.current
    if (!node) return
    registerInput(createTextareaAdapter(node))
    return () => registerInput(null)
  }, [registerInput])

  const resize = React.useCallback(() => {
    const textarea = localRef.current
    if (!textarea) return
    textarea.style.height = "auto"
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`
    textarea.style.overflowY =
      textarea.scrollHeight > textarea.clientHeight ? "auto" : "hidden"
  }, [maxHeight])

  React.useLayoutEffect(() => {
    resize()
    const textarea = localRef.current
    if (!textarea || typeof ResizeObserver === "undefined") return
    let previousWidth = textarea.getBoundingClientRect().width
    const observer = new ResizeObserver(() => {
      const nextWidth = textarea.getBoundingClientRect().width
      if (nextWidth !== previousWidth) {
        previousWidth = nextWidth
        resize()
        return
      }
      // Height-only changes (surrounding rows growing or shrinking under a
      // composer cap) must still refresh scrollability.
      const nextOverflow =
        textarea.scrollHeight > textarea.clientHeight ? "auto" : "hidden"
      if (textarea.style.overflowY !== nextOverflow) {
        textarea.style.overflowY = nextOverflow
      }
    })
    observer.observe(textarea)
    return () => observer.disconnect()
  }, [composerMaxHeight, props.value, props.defaultValue, resize])

  return (
    <textarea
      ref={setRef}
      data-slot="chat-composer-input"
      rows={1}
      aria-label="Message"
      className={cn(
        // The input carries no border or focus outline of its own: browsers
        // apply :focus-visible to editable fields on pointer focus too, so an
        // outline here reads as a permanent inner border. The caret indicates
        // focus; the composer's borderMode owns any surface treatment.
        "min-w-0 w-full resize-none border-0 bg-transparent px-1 py-1 font-sans nessa-text-5 text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
        constrained ? "min-h-0 max-h-full" : "min-h-14",
        size === "compact" && !constrained && "min-h-10 nessa-text-4",
        size === "compact" && constrained && "nessa-text-4",
        className,
      )}
      onChange={(event) => {
        resize()
        onChange?.(event)
      }}
      onPaste={(event) => {
        onPaste?.(event)
        if (event.defaultPrevented || !onPasteAttachment) return
        const text = event.clipboardData.getData("text/plain")
        if (text.length < pasteAttachmentMinLength) return
        event.preventDefault()
        onPasteAttachment(text)
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (
          event.key === "Backspace" &&
          !event.repeat &&
          !event.defaultPrevented &&
          event.currentTarget.selectionStart === 0 &&
          event.currentTarget.selectionEnd === 0
        ) {
          const removers = event.currentTarget.form?.querySelectorAll<
            HTMLButtonElement
          >(
            '[data-slot="chat-composer-attachments"] [data-slot="chat-composer-attachment-remove"]',
          )
          const trailing = removers?.item(removers.length - 1)
          if (trailing) {
            event.preventDefault()
            trailing.click()
            return
          }
        }
        if (
          event.defaultPrevented ||
          !submitOnEnter ||
          event.key !== "Enter" ||
          event.shiftKey ||
          event.nativeEvent.isComposing
        ) {
          return
        }
        event.preventDefault()
        requestComposerSubmit(event.currentTarget.form)
      }}
      {...props}
    />
  )
}

export type ChatComposerAttachmentKind =
  | "skill"
  | "plugin"
  | "pasted-text"
  | "file"
  | "mention"

const attachmentKindIcons: Record<
  ChatComposerAttachmentKind,
  React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>
> = {
  skill: Box,
  plugin: Puzzle,
  "pasted-text": ClipboardType,
  file: Paperclip,
  mention: AtSign,
}

/**
 * Renders an attachment's leading icon: the custom `icon` when provided
 * (null falls back), else the kind's built-in glyph, else nothing. Shared by
 * the attachment pill and the editor chip so kind iconography cannot drift
 * between the two presentations.
 */
export function ChatComposerAttachmentIcon({
  kind,
  icon,
  className,
}: {
  kind?: ChatComposerAttachmentKind
  icon?: React.ReactNode
  className?: string
}) {
  const KindIcon = kind === undefined ? null : attachmentKindIcons[kind]
  const content = icon ?? (KindIcon ? <KindIcon /> : null)
  if (content === null || content === undefined) return null
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center [&_svg]:size-3.5",
        className,
      )}
    >
      {content}
    </span>
  )
}

/**
 * Groups attachment pills into a wrap row above the message input. Renders
 * nothing while it has no children (conditional and mapped children
 * included), so hosts can pass an attachment list unconditionally. Under a
 * composer maxHeight the row caps its own height and scrolls so the input
 * and footer keep their space.
 */
function ChatComposerAttachments({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  const { constrained } = React.useContext(ChatComposerContext)
  const items = React.Children.toArray(children)
  if (items.length === 0) return null
  return (
    <div
      data-slot="chat-composer-attachments"
      className={cn(
        "flex min-w-0 max-w-full flex-wrap items-center gap-1.5 px-1",
        constrained && "min-h-0 max-h-24 overflow-y-auto",
        className,
      )}
      {...props}
    >
      {items}
    </div>
  )
}

export interface ChatComposerAttachmentProps
  extends React.ComponentProps<"span"> {
  /** The plain-text attachment name used for accessible remove labels. */
  itemLabel: string
  /** Selects the built-in leading icon and is exposed as `data-kind` for styling. */
  kind?: ChatComposerAttachmentKind
  /** Replaces the kind's built-in leading icon. */
  icon?: React.ReactNode
  /**
   * Removes the attachment as a whole. Enables the pill's remove button and
   * lets Backspace at the start of the composer input delete the trailing
   * removable pill atomically; pills without onRemove are never removed by
   * keyboard.
   */
  onRemove?: () => void
}

/**
 * Renders one attachment as an atomic text-like pill: a kind icon, a
 * truncating label, and — when removable — a remove control that deletes the
 * whole attachment rather than editing its text.
 */
function ChatComposerAttachment({
  itemLabel,
  kind,
  icon,
  onRemove,
  className,
  children,
  ...props
}: ChatComposerAttachmentProps) {
  return (
    <span
      data-slot="chat-composer-attachment"
      data-kind={kind}
      className={cn(
        "inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-lg bg-accent px-2 font-sans nessa-text-4 text-accent-foreground",
        onRemove && "pr-0.5",
        className,
      )}
      {...props}
    >
      <ChatComposerAttachmentIcon kind={kind} icon={icon} className="size-3.5" />
      <span className="min-w-0 truncate">{children ?? itemLabel}</span>
      {onRemove ? (
        <button
          type="button"
          data-slot="chat-composer-attachment-remove"
          aria-label={`Remove ${itemLabel}`}
          title={`Remove ${itemLabel}`}
          onClick={onRemove}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-md border-0 bg-transparent p-0 text-accent-foreground outline-none transition-colors hover:bg-accent-foreground/10 focus-visible:[outline-style:solid] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&_svg]:size-3.5"
        >
          <X aria-hidden="true" />
        </button>
      ) : null}
    </span>
  )
}

interface TriggerTokenState {
  key: string
  query: string
}

export interface ChatComposerTriggerRenderProps {
  /** The text typed after the trigger sequence, before the caret. */
  query: string
  /** Closes the menu; it stays closed while the trigger sequence remains at the dismissed position. */
  close: () => void
  /**
   * Removes the trigger sequence and query from the input — optionally
   * substituting `replaceWith` — then restores focus and caret. Call it after
   * a selection so the typed token does not remain as message text; with a
   * ChatComposerEditor, follow it with `insertChip` on the editor handle.
   */
  clearTrigger: (replaceWith?: string) => void
}

export interface ChatComposerTriggerProps {
  /**
   * The character sequence that opens the menu, such as `/` or `@`. The menu
   * opens while the caret sits directly after the sequence — typed at the
   * start of the input or after whitespace — and tracks the query typed
   * behind it until whitespace ends the token.
   */
  trigger: string
  /** The accessible name announced for the menu surface. */
  label: string
  /** Observes the menu opening and closing. */
  onOpenChange?: (open: boolean) => void
  /** Extends the classes of the portaled menu panel anchored to the composer. */
  className?: string
  /** Renders the menu content for the current query. */
  children: (state: ChatComposerTriggerRenderProps) => React.ReactNode
}

/**
 * Watches the owning ChatComposer's input — ChatComposerInput or
 * ChatComposerEditor — for a trigger sequence and presents host-supplied menu
 * content anchored above the composer. Focus stays in the input while typing
 * filters the query; Enter or Tab chooses the primary option,
 * ArrowUp/ArrowDown move focus into content rendered with `role="option"`,
 * and Escape or an outside press dismisses the menu until the trigger
 * sequence leaves the dismissed position. While the menu offers a selectable
 * option, Enter selects instead of submitting; without one, Enter keeps its
 * composer submit behavior and Tab keeps moving focus. Render one instance
 * per trigger sequence inside the ChatComposer.
 */
function ChatComposerTrigger({
  trigger,
  label,
  onOpenChange,
  className,
  children,
}: ChatComposerTriggerProps) {
  const { inputAdapter } = React.useContext(ChatComposerContext)
  const [token, setTokenState] = React.useState<TriggerTokenState | null>(null)
  const tokenRef = React.useRef<TriggerTokenState | null>(null)
  const dismissedKey = React.useRef<string | null>(null)
  const contentRef = React.useRef<HTMLDivElement | null>(null)
  const onOpenChangeRef = React.useRef(onOpenChange)
  React.useEffect(() => {
    onOpenChangeRef.current = onOpenChange
  })
  const anchorRef = React.useMemo(
    () => ({ current: inputAdapter?.element.closest("form") ?? null }),
    [inputAdapter],
  )

  const setToken = React.useCallback((next: TriggerTokenState | null) => {
    const wasOpen = tokenRef.current !== null
    tokenRef.current = next
    setTokenState(next)
    const isOpen = next !== null
    if (wasOpen !== isOpen) onOpenChangeRef.current?.(isOpen)
  }, [])

  /** Closes the menu and remembers the token anchor it was dismissed at. */
  const dismiss = React.useCallback(() => {
    if (tokenRef.current) dismissedKey.current = tokenRef.current.key
    setToken(null)
  }, [setToken])

  /**
   * Drops a recorded dismissal once its trigger sequence no longer sits at
   * the dismissed anchor. An Escape dismissal therefore holds against caret
   * movement and further typing inside the same token, but not against edits
   * (including host-driven value resets) that remove the token.
   */
  const reconcileDismissal = React.useCallback(() => {
    if (
      dismissedKey.current !== null &&
      inputAdapter &&
      !inputAdapter.hasTokenAnchor(trigger, dismissedKey.current)
    ) {
      dismissedKey.current = null
    }
  }, [inputAdapter, trigger])

  /** Re-reads the trigger token from the input and syncs the open state. */
  const evaluate = React.useCallback(() => {
    if (!inputAdapter) return
    reconcileDismissal()
    const read = inputAdapter.readToken(trigger)
    const next = read && dismissedKey.current !== read.key ? read : null
    const current = tokenRef.current
    if (next?.key !== current?.key || next?.query !== current?.query) {
      setToken(next)
    }
  }, [inputAdapter, reconcileDismissal, setToken, trigger])

  /** Returns the menu's enabled option elements in document order. */
  const enabledOptions = React.useCallback(() => {
    const content = contentRef.current
    if (!content) return []
    return Array.from(
      content.querySelectorAll<HTMLElement>('[role="option"]'),
    ).filter((option) => !option.matches('[aria-disabled="true"], :disabled'))
  }, [])

  React.useEffect(() => {
    if (!inputAdapter) return
    const element = inputAdapter.element
    const ownerDocument = element.ownerDocument
    let lastAnchorNode: Node | null = null
    let lastAnchorOffset = -1

    const handleKeyDown = (event: KeyboardEvent) => {
      // The content here is pre-edit, so a host-driven reset that removed a
      // dismissed token is observed before this keystroke's input event.
      reconcileDismissal()
      if (!tokenRef.current) return
      if (event.key === "Escape") {
        event.preventDefault()
        dismiss()
        return
      }
      if (event.isComposing) return
      if (
        (event.key === "Enter" || event.key === "Tab") &&
        !event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        const roving = contentRef.current?.querySelector<HTMLElement>(
          '[role="option"][tabindex="0"]',
        )
        const primary =
          roving && !roving.matches('[aria-disabled="true"], :disabled')
            ? roving
            : enabledOptions()[0]
        // Without a selectable option, Enter keeps its composer meaning
        // (submit) and Tab keeps moving focus, instead of dead-ending on an
        // empty menu.
        if (!primary) return
        event.preventDefault()
        primary.click()
        return
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        const options = enabledOptions()
        const target =
          event.key === "ArrowDown" ? options[0] : options[options.length - 1]
        target?.focus()
      }
    }

    const handleInput = () => {
      lastAnchorNode = null
      evaluate()
    }

    const handleSelectionChange = () => {
      if (ownerDocument.activeElement !== element) return
      // Selection noise (pointer moves, focus churn) fires selectionchange
      // without moving the caret; skip re-evaluating those.
      const selection = ownerDocument.getSelection()
      const anchorNode = selection?.anchorNode ?? null
      const anchorOffset = selection?.anchorOffset ?? -1
      if (anchorNode === lastAnchorNode && anchorOffset === lastAnchorOffset) {
        return
      }
      lastAnchorNode = anchorNode
      lastAnchorOffset = anchorOffset
      evaluate()
    }

    const handleBlur = (event: FocusEvent) => {
      const next = event.relatedTarget
      if (next instanceof Node && contentRef.current?.contains(next)) return
      if (!(next instanceof Node)) {
        // Window blur and programmatic blur close the panel without
        // recording a dismissal, so refocusing can reopen it.
        if (tokenRef.current) setToken(null)
        return
      }
      dismiss()
    }

    element.addEventListener("input", handleInput)
    element.addEventListener("keydown", handleKeyDown)
    element.addEventListener("blur", handleBlur)
    ownerDocument.addEventListener("selectionchange", handleSelectionChange)
    return () => {
      element.removeEventListener("input", handleInput)
      element.removeEventListener("keydown", handleKeyDown)
      element.removeEventListener("blur", handleBlur)
      ownerDocument.removeEventListener(
        "selectionchange",
        handleSelectionChange,
      )
    }
  }, [
    dismiss,
    enabledOptions,
    evaluate,
    inputAdapter,
    reconcileDismissal,
    setToken,
  ])

  // Host-driven value changes (submit clearing a controlled value, external
  // resets) update the input without any DOM event. While the menu is open,
  // re-read the token after every commit so it tracks those edits too.
  React.useEffect(() => {
    if (tokenRef.current) evaluate()
  })

  const open = token !== null

  const clearTrigger = React.useCallback(
    (replaceWith?: string) => {
      const active = tokenRef.current
      if (!inputAdapter || !active) return
      // Suppress the token anchor through the rewrite: if the replacement
      // itself begins with the trigger sequence (an inline "@handle"), the
      // menu must not immediately reopen over the completed selection. The
      // suppression clears itself once the trigger sequence leaves that spot.
      dismissedKey.current = active.key
      inputAdapter.replaceToken(trigger, replaceWith ?? "")
    },
    [inputAdapter, trigger],
  )

  /**
   * Redirects panel-focused query typing back into the composer input while
   * leaving editable panel content, Space activation of the focused option,
   * and composition input untouched.
   */
  const handlePanelKeyDown = (event: React.KeyboardEvent) => {
    if (!inputAdapter) return
    if (event.nativeEvent.isComposing) return
    const target = event.target
    if (
      target instanceof HTMLElement &&
      (target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target.isContentEditable)
    ) {
      return
    }
    if (
      event.key === "Tab" &&
      !event.shiftKey &&
      target instanceof HTMLElement &&
      target.getAttribute("role") === "option" &&
      !target.matches('[aria-disabled="true"], :disabled')
    ) {
      // Tab on a focused option selects it, matching Enter.
      event.preventDefault()
      target.click()
      return
    }
    if (event.key === " ") return
    if (event.key === "Backspace") {
      event.preventDefault()
      inputAdapter.deleteBackward()
      return
    }
    if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault()
      inputAdapter.insertText(event.key)
    }
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) dismiss()
      }}
    >
      <Popover.Anchor virtualRef={anchorRef} />
      <Popover.Portal>
        <Popover.Content
          ref={contentRef}
          data-slot="chat-composer-trigger-panel"
          data-trigger={trigger}
          aria-label={label}
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={() => inputAdapter?.element.focus()}
          onPointerDownOutside={(event) => {
            if (
              event.target instanceof Node &&
              inputAdapter?.element.contains(event.target)
            ) {
              event.preventDefault()
            }
          }}
          onFocusOutside={(event) => {
            // Redirected panel typing refocuses the composer input; that
            // must not read as an outside interaction that dismisses the
            // menu mid-query.
            if (
              event.target instanceof Node &&
              inputAdapter?.element.contains(event.target)
            ) {
              event.preventDefault()
            }
          }}
          onKeyDown={handlePanelKeyDown}
          className={cn(
            "z-50 w-[var(--radix-popover-trigger-width)] overflow-hidden rounded-2xl border border-border bg-popover font-sans text-popover-foreground shadow-xl outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            className,
          )}
        >
          {children({
            query: token?.query ?? "",
            close: dismiss,
            clearTrigger,
          })}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

/** Renders the wrapping footer row that positions composer action groups. */
function ChatComposerFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="chat-composer-footer"
      className={cn(
        "flex min-w-0 flex-wrap items-end justify-between gap-2",
        className,
      )}
      {...props}
    />
  )
}

/** Groups related composer actions into one non-wrapping control cluster. */
function ChatComposerActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="chat-composer-actions"
      className={cn(
        "flex min-w-0 max-w-full flex-nowrap items-center gap-1",
        className,
      )}
      {...props}
    />
  )
}

export interface ChatComposerActionProps
  extends React.ComponentPropsWithRef<"button"> {}

/** Renders a compact non-submit composer action. */
function ChatComposerAction({ className, ref, ...props }: ChatComposerActionProps) {
  return (
    <button
      ref={ref}
      type="button"
      data-slot="chat-composer-action"
      className={cn(
        "inline-flex size-9 shrink-0 items-center justify-center rounded-full border-0 bg-transparent p-0 text-foreground outline-none transition-[color,background-color,box-shadow,transform] hover:bg-accent hover:text-accent-foreground focus-visible:[outline-style:solid] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 active:translate-y-px [&_svg]:size-4",
        className,
      )}
      {...props}
    />
  )
}

export interface ChatComposerSubmitProps
  extends React.ComponentPropsWithRef<"button"> {
  loading?: boolean
}

/** Renders the submit action with an icon-only loading fallback. */
function ChatComposerSubmit({
  className,
  loading = false,
  children,
  disabled,
  ref,
  "aria-label": ariaLabel,
  ...props
}: ChatComposerSubmitProps) {
  return (
    <button
      ref={ref}
      type="submit"
      data-slot="chat-composer-submit"
      aria-label={
        ariaLabel ??
        (children == null ? (loading ? "Sending message" : "Send message") : undefined)
      }
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={cn(
        "inline-flex size-9 shrink-0 items-center justify-center rounded-full border-0 bg-primary p-0 text-primary-foreground shadow-xs outline-none transition-[color,background-color,box-shadow,transform] hover:bg-primary/90 focus-visible:[outline-style:solid] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 active:translate-y-px [&_svg]:size-4",
        className,
      )}
      {...props}
    >
      {children ??
        (loading ? (
          <LoaderCircle aria-hidden="true" className="animate-spin" />
        ) : (
          <ArrowUp aria-hidden="true" />
        ))}
    </button>
  )
}

export {
  ChatComposer,
  ChatComposerAction,
  ChatComposerActions,
  ChatComposerAttachment,
  ChatComposerAttachments,
  ChatComposerFooter,
  ChatComposerInput,
  ChatComposerSubmit,
  ChatComposerTrigger,
}
