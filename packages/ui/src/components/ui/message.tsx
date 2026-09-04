import * as React from "react"
import { ChevronLeft, ChevronRight, FileText } from "lucide-react"

import { cn } from "@/lib/utils"

export type MessageAlign = "start" | "end"

/** A single conversation row that lays out optional avatar and content slots. */
export interface MessageProps extends React.ComponentProps<"div"> {
  /**
   * Which participant sent the message. Sets the default alignment — `user`
   * rows end-align, `assistant` rows start-align — and is exposed as
   * `data-from` so hosts can restyle either side from CSS.
   */
  from?: "user" | "assistant"
  /**
   * Overrides the alignment derived from `from`; without either prop the row
   * aligns `start`.
   */
  align?: MessageAlign
}

function Message({ from, align, className, ...props }: MessageProps) {
  const resolvedAlign = align ?? (from === "user" ? "end" : "start")
  return (
    <div
      data-slot="message"
      data-from={from}
      data-align={resolvedAlign}
      className={cn(
        "group/message flex w-full max-w-full items-end gap-2 font-sans",
        "data-[align=end]:justify-end",
        className,
      )}
      {...props}
    />
  )
}

export interface MessageGroupProps extends React.ComponentProps<"div"> {}

/** Stacks consecutive messages from the same sender with tightened spacing. */
function MessageGroup({ className, ...props }: MessageGroupProps) {
  return (
    <div
      data-slot="message-group"
      className={cn("flex w-full flex-col gap-1 font-sans", className)}
      {...props}
    />
  )
}

export interface MessageAvatarProps extends React.ComponentProps<"div"> {
  /** Image source for the avatar; `fallback` renders when absent or failed. */
  src?: string
  alt?: string
  /** Short fallback content, typically initials, shown without an image. */
  fallback?: React.ReactNode
}

/**
 * The avatar slot beside a message. Renders `src` or `fallback` by default,
 * while any `children` replace the built-in rendering entirely. When no image
 * renders, a non-empty `alt` names the slot itself so fallback initials stay
 * decorative.
 */
function MessageAvatar({
  src,
  alt = "",
  fallback,
  className,
  children,
  ...props
}: MessageAvatarProps) {
  const [failedSrc, setFailedSrc] = React.useState<string | null>(null)
  const showImage = src !== undefined && src !== failedSrc
  const rendersImage = children == null && showImage
  const label = !rendersImage && alt !== "" ? alt : undefined
  return (
    <div
      data-slot="message-avatar"
      role={label === undefined ? undefined : "img"}
      aria-label={label}
      className={cn(
        "flex size-8 shrink-0 select-none items-center justify-center overflow-hidden rounded-full bg-muted nessa-text-2 font-medium text-muted-foreground",
        className,
      )}
      {...props}
    >
      {children ??
        (showImage ? (
          <img
            src={src}
            alt={alt}
            className="size-full object-cover"
            onError={() => setFailedSrc(src)}
          />
        ) : (
          <span aria-hidden="true">{fallback}</span>
        ))}
    </div>
  )
}

export interface MessageContentProps extends React.ComponentProps<"div"> {}

/** Columns the header, bubble, and footer beside the avatar. */
function MessageContent({ className, ...props }: MessageContentProps) {
  return (
    <div
      data-slot="message-content"
      className={cn(
        "flex min-w-0 max-w-[75%] flex-col items-start gap-1",
        "group-data-[align=end]/message:items-end",
        className,
      )}
      {...props}
    />
  )
}

export type MessageBubbleVariant = "muted" | "primary" | "plain"

export interface MessageBubbleProps extends React.ComponentProps<"div"> {
  /**
   * The bubble surface: `muted` for received messages, `primary` for sent
   * messages, and `plain` for unbubbled prose such as assistant responses.
   */
  variant?: MessageBubbleVariant
  /**
   * Marks content that is still streaming in: sets `aria-busy` and
   * `data-streaming` so hosts can style the in-flight state. The host owns
   * the stream and simply re-renders children as chunks arrive.
   */
  streaming?: boolean
}

function MessageBubble({
  variant = "muted",
  streaming = false,
  className,
  ...props
}: MessageBubbleProps) {
  return (
    <div
      data-slot="message-bubble"
      data-variant={variant}
      data-streaming={streaming ? "true" : undefined}
      aria-busy={streaming || undefined}
      className={cn(
        "w-fit min-w-0 max-w-full whitespace-pre-wrap break-words text-left nessa-text-4 leading-6",
        variant === "muted" && "rounded-2xl bg-muted px-4 py-2.5 text-foreground",
        variant === "primary" &&
          "rounded-2xl bg-primary px-4 py-2.5 text-primary-foreground",
        variant === "plain" && "py-1 text-foreground",
        className,
      )}
      {...props}
    />
  )
}

export interface MessageStreamTextState {
  /** The smoothed text revealed so far. */
  text: string
  /**
   * Length of the leading portion of `text` that should render without
   * animation: everything present at mount, after a prefix rewrite, or whose
   * fade already finished. Characters past this index are freshly revealed.
   */
  staticLength: number
  /** True once every character received so far has been revealed. */
  done: boolean
}

export interface MessageStreamTextOptions {
  /**
   * Minimum reveal rate in characters per second — the floor used to finish
   * the tail once the stream runs dry. Everywhere else the reveal paces
   * itself to the incoming stream: it aims to trail the newest received text
   * by `trail` seconds, so fast streams reveal fast and slow streams reveal
   * slowly, with no artificial ceiling. Defaults to 200.
   */
  speed?: number
  /**
   * Target cushion, in seconds, between the revealed text and the newest
   * received text. Smaller values hug the stream edge and stall sooner;
   * larger values buffer more and ride out burstier streams. Defaults to 0.3.
   */
  trail?: number
  /**
   * Seconds for the reveal velocity to ease toward its target. Higher values
   * smooth chunk boundaries harder; 0 tracks the target instantly. Defaults
   * to 0.4.
   */
  adapt?: number
  /**
   * Fade duration, in milliseconds, for each newly revealed character.
   * Defaults to 1000 — the long overlapping fades give arriving text its
   * soft shimmer.
   */
  fade?: number
}

/** Extra time past the fade before a character folds into the static prefix. */
const STREAM_FOLD_SLACK_MS = 50
/**
 * Ceiling on carried reveal budget and on any single grapheme's pacing cost,
 * in characters. The two must share one value: if a grapheme could cost more
 * than the budget can hold, it could never be afforded and the reveal would
 * stall on it forever.
 */
const STREAM_BUDGET_CAP = 24

/** Splits on grapheme boundaries so the reveal never lands inside an emoji. */
function segmentGraphemes(text: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    return Array.from(new Intl.Segmenter().segment(text), (s) => s.segment)
  }
  return Array.from(text)
}

/**
 * The smoothing behind MessageStreamText, exposed for custom displays: feed
 * it the complete text received so far and it releases the backlog at a
 * steady character rate, reporting which trailing characters are freshly
 * revealed. Use it directly (or the `children` render prop) to swap the
 * default letter fade for another treatment without giving up the pacing.
 */
function useMessageStreamText(
  text: string,
  { speed = 200, trail = 0.3, adapt = 0.4, fade = 1000 }: MessageStreamTextOptions = {},
): MessageStreamTextState {
  const [view, setView] = React.useState<MessageStreamTextState>(() => ({
    // Text present on first render shows immediately without animating, so
    // opening a saved transcript never replays the reveal.
    text,
    staticLength: text.length,
    done: true,
  }))
  const revealState = React.useRef({
    revealed: text.length,
    staticLength: text.length,
    // Current reveal velocity in characters per second. It eases toward the
    // pace of the incoming stream and is kept across stalls, so a resumed
    // stream picks up at the speed it left off.
    rate: 0,
    budget: 0,
    previousText: text,
    pending: [] as { length: number; at: number }[],
  })

  React.useEffect(() => {
    const state = revealState.current
    const previous = state.previousText
    state.previousText = text
    if (!text.startsWith(previous)) {
      // A rewritten prefix snaps to the new value without animating.
      state.revealed = text.length
      state.staticLength = text.length
      state.rate = 0
      state.budget = 0
      state.pending = []
      setView({ text, staticLength: text.length, done: true })
      return
    }
    if (state.revealed >= text.length && state.staticLength >= state.revealed) {
      return
    }
    const graphemes = segmentGraphemes(text)
    let total = 0
    const cumulative = graphemes.map((grapheme) => (total += grapheme.length))
    let index = cumulative.findIndex((end) => end > state.revealed)
    if (index === -1) index = graphemes.length
    let frame: number
    let last = performance.now()
    const step = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      const backlog = text.length - state.revealed
      if (backlog > 0) {
        // Pace the reveal to the stream itself: aim to drain the backlog over
        // the trail window, so the reveal rides `trail` seconds behind
        // however fast text actually arrives, with no ceiling. The floor only
        // finishes the tail once the stream runs dry. Easing the velocity
        // toward that target keeps the motion continuous instead of surging
        // at every chunk boundary.
        const target = Math.max(speed, backlog / trail)
        state.rate += (target - state.rate) * (1 - Math.exp(-dt / adapt))
        let advance = state.rate * dt + state.budget
        while (index < graphemes.length) {
          // A grapheme's pacing cost is capped at the budget ceiling so one
          // enormous cluster (e.g. a run of combining marks that segments as
          // a single grapheme) can never exceed the per-frame budget and
          // stall the reveal permanently.
          const cost = Math.min(graphemes[index]!.length, STREAM_BUDGET_CAP)
          if (cost > advance) break
          advance -= cost
          index += 1
        }
        // Cap the carried budget so a pause never banks an instant burst.
        state.budget = Math.min(advance, STREAM_BUDGET_CAP)
        const revealed = index > 0 ? cumulative[index - 1]! : 0
        if (revealed !== state.revealed) {
          state.revealed = revealed
          state.pending.push({ length: revealed, at: now })
        }
      }
      // Fold characters whose fade has finished into the static prefix so a
      // long reply settles back into one plain text node instead of
      // accumulating a span per character.
      while (
        state.pending.length > 0 &&
        state.pending[0]!.at <= now - (fade + STREAM_FOLD_SLACK_MS)
      ) {
        state.staticLength = state.pending.shift()!.length
      }
      const done = state.revealed >= text.length
      setView((current) =>
        current.text.length === state.revealed &&
        current.staticLength === state.staticLength &&
        current.done === done
          ? current
          : {
              text: text.slice(0, state.revealed),
              staticLength: state.staticLength,
              done,
            },
      )
      if (state.revealed < text.length || state.staticLength < state.revealed) {
        frame = requestAnimationFrame(step)
      }
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [adapt, fade, speed, text, trail])

  return view
}

export interface MessageStreamTextProps
  extends Omit<React.ComponentProps<"span">, "children">,
    MessageStreamTextOptions {
  /** The full streamed text received so far. */
  text: string
  /**
   * Replaces the default letter-by-letter fade with a custom display of the
   * smoothed stream. The pacing stays identical; only the rendering of the
   * revealed text changes.
   */
  children?: (state: MessageStreamTextState) => React.ReactNode
}

/**
 * The one streaming text display: it smooths bursty stream chunks into a
 * continuous letter-by-letter reveal. The reveal paces itself to the incoming
 * stream — fast streams reveal fast, slow streams reveal slowly, trailing the
 * newest text by roughly a third of a second — and each newly revealed
 * character fades in, so chunk boundaries disappear into one even flow of
 * arriving text. It pauses only when the buffer truly runs dry and resumes at
 * the same velocity. The host keeps passing the complete text received so
 * far. Text present on first render appears immediately without animating,
 * and a rewritten prefix snaps to the new value. Pass a `children` render
 * function (or use useMessageStreamText directly) to swap the display
 * treatment while keeping the smoothing.
 */
function MessageStreamText({
  text,
  speed,
  trail,
  adapt,
  fade = 1000,
  children,
  ...props
}: MessageStreamTextProps) {
  const state = useMessageStreamText(text, { speed, trail, adapt, fade })
  const tail = React.useMemo(() => {
    const graphemes = segmentGraphemes(state.text.slice(state.staticLength))
    let offset = state.staticLength
    return graphemes.map((grapheme) => {
      const entry = { key: offset, grapheme }
      offset += grapheme.length
      return entry
    })
  }, [state.staticLength, state.text])

  return (
    <span data-slot="message-stream-text" {...props}>
      {children !== undefined ? (
        children(state)
      ) : (
        <>
          {state.text.slice(0, state.staticLength)}
          {tail.map(({ key, grapheme }) => (
            <span
              key={key}
              style={{ "--message-grapheme-fade": `${fade}ms` } as React.CSSProperties}
              className="opacity-100 transition-opacity duration-(--message-grapheme-fade) ease-out starting:opacity-0 motion-reduce:transition-none"
            >
              {grapheme}
            </span>
          ))}
        </>
      )}
    </span>
  )
}

export interface MessageHeaderProps extends React.ComponentProps<"div"> {}

/** Meta content above the bubble, such as the sender name. */
function MessageHeader({ className, ...props }: MessageHeaderProps) {
  return (
    <div
      data-slot="message-header"
      className={cn(
        "flex items-center gap-2 px-1 nessa-text-2 font-medium text-muted-foreground",
        className,
      )}
      {...props}
    />
  )
}

export interface MessageFooterProps extends React.ComponentProps<"div"> {}

/** Meta content below the bubble, such as delivery status or actions. */
function MessageFooter({ className, ...props }: MessageFooterProps) {
  return (
    <div
      data-slot="message-footer"
      className={cn(
        "flex items-center gap-2 px-1 nessa-text-2 text-muted-foreground",
        className,
      )}
      {...props}
    />
  )
}

export interface MessageActionsProps extends React.ComponentProps<"div"> {}

/**
 * The hover-revealed action row under a bubble: MessageAction icon buttons,
 * optionally alongside meta text such as the sent time. Hidden until the
 * pointer hovers anywhere on the message row or an action holds keyboard
 * focus, so transcripts stay quiet while copy, edit, and retry affordances
 * stay one hover away. Pass `className="opacity-100"` to keep a row's actions
 * always visible.
 */
function MessageActions({ className, ...props }: MessageActionsProps) {
  return (
    <div
      data-slot="message-actions"
      className={cn(
        // Reveal binds to :focus-visible, not :focus-within: a pointer click
        // parks focus on the clicked action, and plain focus-within would
        // keep the row lit after the pointer moves on.
        "flex items-center gap-1 px-1 nessa-text-2 text-muted-foreground opacity-0 transition-opacity group-hover/message:opacity-100 group-has-[:focus-visible]/message:opacity-100",
        className,
      )}
      {...props}
    />
  )
}

export interface MessageActionProps extends React.ComponentProps<"button"> {}

/**
 * One icon action in a MessageActions row. Icon-only by design, so name each
 * action with `aria-label`; what clicking it does — copying, entering an edit
 * state, retrying — stays host-owned through `onClick`.
 */
function MessageAction({
  className,
  type = "button",
  ...props
}: MessageActionProps) {
  return (
    <button
      type={type}
      data-slot="message-action"
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&_svg]:size-3.5 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  )
}

export interface MessageAttachmentsProps extends React.ComponentProps<"div"> {}

const attachmentPagerButtonClass =
  "flex size-6 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&_svg]:size-3.5"

/**
 * Presents a message's attachments one at a time in a uniform square tile
 * inside MessageContent. With more than one attachment a compact pager —
 * previous and next controls around a live position counter — steps through
 * them; a single attachment renders without the pager. Each attachment stays
 * a MessageAttachment child, so the host decides what clicking one does.
 */
function MessageAttachments({
  className,
  children,
  ...props
}: MessageAttachmentsProps) {
  const items = React.Children.toArray(children)
  const [index, setIndex] = React.useState(0)
  const active = Math.min(index, Math.max(items.length - 1, 0))
  return (
    <div
      data-slot="message-attachments"
      className={cn(
        "flex w-fit max-w-full min-w-0 flex-col items-start gap-1.5",
        "group-data-[align=end]/message:items-end",
        className,
      )}
      {...props}
    >
      {items[active] ?? null}
      {items.length > 1 && (
        <div
          data-slot="message-attachments-pager"
          className="flex items-center gap-1.5"
        >
          <button
            type="button"
            aria-label="Previous attachment"
            disabled={active === 0}
            onClick={() => setIndex(Math.max(active - 1, 0))}
            className={attachmentPagerButtonClass}
          >
            <ChevronLeft aria-hidden="true" />
          </button>
          <span
            aria-live="polite"
            className="nessa-text-2 tabular-nums text-muted-foreground"
          >
            {active + 1} / {items.length}
          </span>
          <button
            type="button"
            aria-label="Next attachment"
            disabled={active === items.length - 1}
            onClick={() => setIndex(Math.min(active + 1, items.length - 1))}
            className={attachmentPagerButtonClass}
          >
            <ChevronRight aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  )
}

export interface MessageAttachmentProps extends React.ComponentProps<"div"> {
  /**
   * The attachment file name. Labels the tile: shown on file tiles, used as
   * the image alt on non-interactive thumbnails, and as the button's
   * accessible name on interactive image tiles (where the image itself is
   * decorative).
   */
  name?: string
  /** Muted secondary line such as the file type or size. */
  meta?: React.ReactNode
  /** Image source; when set the tile shows the image as its preview. */
  src?: string
  /** Preview icon for non-image attachments. Defaults to a document glyph. */
  icon?: React.ReactNode
}

/**
 * One attachment in the same square tile regardless of kind: images fill the
 * tile as a thumbnail, everything else shows an icon with the name and meta
 * stacked beneath. Passing `onClick` renders the tile as a button, so the
 * host wires whatever opening, previewing, or downloading behavior it wants;
 * without `onClick` the tile is a plain preview.
 */
function MessageAttachment({
  name,
  meta,
  src,
  icon,
  className,
  children,
  onClick,
  ...props
}: MessageAttachmentProps) {
  const interactive = onClick != null
  const tileClassName = cn(
    "relative flex size-36 shrink-0 flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl border border-border bg-muted text-center",
    interactive &&
      "cursor-pointer transition-colors hover:border-ring/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
    className,
  )
  const content =
    src !== undefined ? (
      <>
        {/* Inside a labeled button the image is decorative; standalone, the
            alt carries the name. */}
        <img
          src={src}
          alt={interactive ? "" : (name ?? "")}
          className="absolute inset-0 size-full object-cover"
        />
        {children}
      </>
    ) : (
      <>
        <span
          aria-hidden="true"
          className="flex size-10 items-center justify-center rounded-xl bg-background text-muted-foreground [&_svg]:size-5"
        >
          {icon ?? <FileText />}
        </span>
        {name != null && (
          <span className="max-w-full truncate px-3 nessa-text-4 font-medium text-foreground">
            {name}
          </span>
        )}
        {meta != null && (
          <span className="max-w-full truncate px-3 nessa-text-2 text-muted-foreground">
            {meta}
          </span>
        )}
        {children}
      </>
    )
  const kind = src !== undefined ? "image" : "file"
  if (interactive) {
    return (
      <button
        type="button"
        data-slot="message-attachment"
        data-kind={kind}
        // File tiles are usually named by their visible text; tiles without
        // any text content (all image tiles, text-free file tiles) carry the
        // name on the button itself.
        aria-label={
          kind === "image" || (name == null && meta == null)
            ? (name ?? "Attachment")
            : undefined
        }
        onClick={onClick as unknown as React.MouseEventHandler<HTMLButtonElement>}
        className={tileClassName}
        {...(props as React.ComponentProps<"button">)}
      >
        {content}
      </button>
    )
  }
  return (
    <div
      data-slot="message-attachment"
      data-kind={kind}
      className={tileClassName}
      {...props}
    >
      {content}
    </div>
  )
}

export interface MessageThreadProps extends React.ComponentProps<"div"> {}

/** Wraps a parent message with its reply summary and nested replies. */
function MessageThread({ className, ...props }: MessageThreadProps) {
  return (
    <div
      data-slot="message-thread"
      className={cn("flex w-full max-w-full flex-col gap-1 font-sans", className)}
      {...props}
    />
  )
}

export interface MessageThreadSummaryProps
  extends React.ComponentProps<"button"> {
  /** The reply-count text, styled as the thread link, e.g. "3 replies". */
  label?: React.ReactNode
  /**
   * Muted trailing meta such as the last-reply time; cross-fades to `action`
   * while hovered or focused.
   */
  meta?: React.ReactNode
  /**
   * Shown in place of `meta` while hovered or focused, in the same reserved
   * grid cell so the button never resizes. Defaults to "View thread". Without
   * `meta` it renders statically; pass `null` to omit it.
   */
  action?: React.ReactNode
}

/**
 * The clickable reply summary under a threaded message. Children render as a
 * facepile — nested MessageAvatars shrink automatically — ahead of the label
 * and meta text. Expansion state stays host-owned through `onClick` and
 * `aria-expanded`. Like MessageThreadReplies, it indents to the parent's
 * content column by default; override with `className` when the parent row
 * has no avatar. When both `meta` and `action` are given they share one grid
 * cell and cross-fade, so the button's geometry and accessible name never
 * change while hovered or focused.
 */
function MessageThreadSummary({
  label,
  meta,
  action = "View thread",
  className,
  children,
  ...props
}: MessageThreadSummaryProps) {
  const swapsToAction = meta != null && action != null
  return (
    <button
      type="button"
      data-slot="message-thread-summary"
      className={cn(
        "group/thread-summary ml-10 flex w-fit min-w-0 items-center gap-1.5 rounded-lg border border-transparent bg-transparent px-1.5 py-1 nessa-text-2 font-medium text-foreground outline-none transition-[border-color,background-color] hover:border-border hover:bg-background focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "[&_[data-slot=message-avatar]]:size-5 [&_[data-slot=message-avatar]]:text-[0.8333em]",
        className,
      )}
      {...props}
    >
      {children != null && (
        <span className="flex items-center gap-1">{children}</span>
      )}
      {label != null && <span className="text-primary">{label}</span>}
      {swapsToAction ? (
        <span className="grid text-left font-normal text-muted-foreground">
          <span className="col-start-1 row-start-1 transition-opacity group-hover/thread-summary:opacity-0 group-focus-visible/thread-summary:opacity-0">
            {meta}
          </span>
          <span
            aria-hidden="true"
            className="col-start-1 row-start-1 opacity-0 transition-opacity group-hover/thread-summary:opacity-100 group-focus-visible/thread-summary:opacity-100"
          >
            {action}
          </span>
        </span>
      ) : (
        (meta ?? action) != null && (
          <span className="font-normal text-muted-foreground">
            {meta ?? action}
          </span>
        )
      )}
    </button>
  )
}

export interface MessageThreadRepliesProps
  extends React.ComponentProps<"div"> {}

/**
 * The nested reply list, indented to the parent's content column with a
 * connector rule under the parent avatar.
 */
function MessageThreadReplies({
  className,
  ...props
}: MessageThreadRepliesProps) {
  return (
    <div
      data-slot="message-thread-replies"
      className={cn(
        "relative flex w-full min-w-0 flex-col gap-3 pl-10",
        "before:absolute before:bottom-1 before:left-4 before:top-1 before:w-px before:bg-border",
        className,
      )}
      {...props}
    />
  )
}

export {
  Message,
  MessageAction,
  MessageActions,
  MessageAttachment,
  MessageAttachments,
  MessageAvatar,
  MessageBubble,
  MessageContent,
  MessageFooter,
  MessageGroup,
  MessageHeader,
  MessageStreamText,
  MessageThread,
  MessageThreadReplies,
  MessageThreadSummary,
  useMessageStreamText,
}
