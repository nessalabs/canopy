import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { ChevronDown } from "lucide-react"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

/** @responsibility Provides semantic navigation lists, complete rows, and loading states. */

/**
 * Decorative branch guides drawn by a nested list for its own rows.
 *
 * A row's guide is two pieces. The elbow is one bordered box whose
 * logical-start and block-end edges meet at a rounded corner, so a single
 * element draws both legs and mirrors under RTL. The spine is a full-height
 * rule that every row except the last draws, overshooting the row by the
 * list's own `gap-0.5` so it meets the next row's spine.
 *
 * The spine runs the row's whole height rather than starting at the branch
 * point: the elbow's rounded corner leaves its vertical leg short by the
 * corner radius, so a spine starting at the branch would open a gap the
 * width of that radius. Running the full height makes one unbroken line
 * that the elbow branches off, and leaves the last row — which draws no
 * spine — terminating at its own elbow.
 *
 * Every dimension and the colour are custom properties so hosts can retune
 * the guides without restating the geometry.
 */
const sidebarMenuGuideClasses = [
  "[--nessa-sidebar-guide-inset:1.25rem]",
  "[--nessa-sidebar-guide-reach:0.75rem]",
  "[--nessa-sidebar-guide-branch:1rem]",
  "[--nessa-sidebar-guide-width:1px]",
  "[--nessa-sidebar-guide-radius:0.375rem]",
  "[--nessa-sidebar-guide-color:var(--color-sidebar-border)]",
  // Elbow: the branch from the spine across to the row.
  "[&>li]:before:pointer-events-none [&>li]:before:absolute [&>li]:before:z-10 [&>li]:before:content-['']",
  "[&>li]:before:top-0 [&>li]:before:start-(--nessa-sidebar-guide-inset)",
  "[&>li]:before:h-(--nessa-sidebar-guide-branch) [&>li]:before:w-(--nessa-sidebar-guide-reach)",
  "[&>li]:before:rounded-es-[var(--nessa-sidebar-guide-radius)]",
  "[&>li]:before:border-s-[length:var(--nessa-sidebar-guide-width)]",
  "[&>li]:before:border-b-[length:var(--nessa-sidebar-guide-width)]",
  "[&>li]:before:border-[color:var(--nessa-sidebar-guide-color)]",
  // Spine: the unbroken rule carrying on to the next row's elbow.
  "[&>li:not(:last-child)]:after:pointer-events-none [&>li:not(:last-child)]:after:absolute [&>li:not(:last-child)]:after:z-10 [&>li:not(:last-child)]:after:content-['']",
  "[&>li:not(:last-child)]:after:top-0 [&>li:not(:last-child)]:after:-bottom-0.5",
  "[&>li:not(:last-child)]:after:start-(--nessa-sidebar-guide-inset)",
  "[&>li:not(:last-child)]:after:w-(--nessa-sidebar-guide-width)",
  "[&>li:not(:last-child)]:after:bg-[var(--nessa-sidebar-guide-color)]",
].join(" ")

/** Properties accepted by a semantic Sidebar navigation list. */
interface SidebarMenuProps extends React.ComponentProps<"ul"> {
  /**
   * Marks the list as nested navigation and applies nested-row behavior.
   * @defaultValue false
   */
  nested?: boolean
  /**
   * Draws decorative branch guides connecting the list's rows to their
   * parent row. Applies only to a `nested` list, which is the only list
   * that has a parent to connect to. The guides are pure presentation:
   * hierarchy remains carried by the nested list structure itself.
   *
   * Retune the guides with custom properties, all settable on the list or
   * any ancestor: `--nessa-sidebar-guide-inset` (offset from the logical
   * start), `--nessa-sidebar-guide-reach` (how far the elbow crosses toward
   * the row), `--nessa-sidebar-guide-branch` (where on the row the elbow
   * meets it), `--nessa-sidebar-guide-width` (line thickness),
   * `--nessa-sidebar-guide-radius` (elbow corner), and
   * `--nessa-sidebar-guide-color` (defaults to the sidebar border token).
   *
   * @defaultValue false
   */
  guides?: boolean
}

/**
 * Renders a semantic list of Sidebar navigation rows.
 *
 * @param props - Native list properties, whether the list represents nested navigation, and whether it draws branch guides.
 * @returns A vertical, unstyled Sidebar navigation list.
 */
function SidebarMenu({
  nested = false,
  guides = false,
  className,
  ...props
}: SidebarMenuProps) {
  const guided = nested && guides

  return (
    <ul
      data-slot="sidebar-menu"
      data-nested={nested || undefined}
      data-guides={guided || undefined}
      className={cn(
        "group/menu flex w-full min-w-0 list-none flex-col gap-0.5 p-0",
        nested && "group-data-[state=collapsed]/sidebar:hidden",
        guided && sidebarMenuGuideClasses,
        className,
      )}
      {...props}
    />
  )
}

// Composite row

/**
 * Reveal treatment for trailing content that only appears on hover.
 *
 * Keyboard focus reveals through `:focus-visible`, not `:focus-within`: a
 * mouse click leaves focus inside the row it clicked, and `:focus-within`
 * would keep that row's trailing revealed while the pointer is over a
 * different row — two rows showing their actions at once.
 */
const sidebarMenuRevealClassName =
  "[@media(hover:hover)_and_(pointer:fine)]:pointer-events-none [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-has-[:focus-visible]/menu-item:pointer-events-auto [@media(hover:hover)_and_(pointer:fine)]:group-has-[:focus-visible]/menu-item:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-hover/menu-item:pointer-events-auto [@media(hover:hover)_and_(pointer:fine)]:group-hover/menu-item:opacity-100"

/** The resting half of a badge/trailing swap: present until the row is engaged. */
const sidebarMenuSwapRestClassName =
  "transition-opacity [@media(hover:hover)_and_(pointer:fine)]:group-has-[:focus-visible]/menu-item:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover/menu-item:opacity-0"

/**
 * The swap's container. Only a fine pointer has a hover state to reveal on,
 * so only there do the two halves share a cell. On a coarse pointer nothing
 * hides either half, and stacking them would print the badge through the
 * action — they sit side by side instead, which is also how the non-swap
 * arrangement degrades.
 */
const sidebarMenuSwapClassName =
  "flex items-center gap-1 [@media(hover:hover)_and_(pointer:fine)]:grid [@media(hover:hover)_and_(pointer:fine)]:place-items-center"

/** The badge's own presentation, shared by both trailing arrangements. */
const sidebarMenuBadgeClassName =
  "pointer-events-none inline-flex min-w-6 items-center justify-center nessa-text-2 font-medium tabular-nums text-sidebar-foreground/60 group-has-data-[active=true]/menu-item:text-sidebar-accent-foreground"

/**
 * Creates the class names for a supported Sidebar menu-item presentation.
 *
 * @param options - Variant, size, inset, and optional class-name selections.
 * @returns The composed class-name string for a Sidebar menu-item control.
 */
const sidebarMenuItemVariants = cva(
  "group/menu-button relative flex w-full min-w-0 appearance-none items-center gap-2.5 overflow-hidden rounded-lg border-0 bg-transparent text-left font-sans nessa-text-4 font-normal text-sidebar-foreground no-underline outline-none transition-[color,background-color,box-shadow,padding] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sidebar-ring disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground group-data-[has-trailing=true]/menu-item:pe-16 group-data-[nested=true]/menu:min-h-8 group-data-[nested=true]/menu:ps-10 group-data-[state=collapsed]/sidebar:justify-center group-data-[state=collapsed]/sidebar:px-0",
  {
    variants: {
      variant: {
        default: "",
        outline: "border border-sidebar-border bg-sidebar shadow-xs",
      },
      size: {
        sm: "min-h-8 px-2 nessa-text-2",
        default: "min-h-9 px-2.5",
        lg: "min-h-12 px-2.5",
      },
      inset: {
        true: "ps-9",
        false: "",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
      inset: false,
    },
  },
)

/** Properties accepted by a complete Sidebar navigation row. */
interface SidebarMenuItemProps
  extends Omit<React.ComponentProps<"button">, "children">,
    VariantProps<typeof sidebarMenuItemVariants> {
  /**
   * Merges control behavior and styling into the single child element.
   * @defaultValue false
   */
  asChild?: boolean
  /** Compact status or count displayed in the trailing region. */
  badge?: React.ReactNode
  /** Primary row label, or the child element used when `asChild` is enabled. */
  children: React.ReactNode
  /** Alternate leading content displayed while the Sidebar is icon-collapsed. */
  collapsedIcon?: React.ReactNode
  /** Optional class name applied to the row's list-item container. */
  containerClassName?: string
  /** Supporting text displayed below the primary row label. */
  description?: React.ReactNode
  /** Decorative leading content displayed before the label. */
  icon?: React.ReactNode
  /**
   * Applies active visual styling without adding an ARIA state. Consumers must
   * supply the appropriate native or ARIA state for the row's interaction.
   * @defaultValue false
   */
  isActive?: boolean
  /**
   * Reveals trailing content on hover or keyboard focus when a fine pointer
   * is available. With a `badge` also present the two share one cell and
   * swap, so revealing the action costs neither width nor the row's resting
   * count; without one the trailing region simply fades in. A coarse pointer
   * has nothing to reveal on, so trailing content stays present there.
   * @defaultValue false
   */
  showTrailingOnHover?: boolean
  /** Optional nested list rendered after the row control. */
  submenu?: React.ReactNode
  /**
   * Turns `submenu` into a disclosure and chooses what operates it.
   * `"row"` makes the row control itself the disclosure button, for a
   * parent that is only a container; `"chevron"` adds a separate control at
   * the logical start so the row stays free to navigate. Has no effect
   * without a `submenu`.
   */
  collapsible?: "row" | "chevron"
  /**
   * Accessible name for a `"chevron"` disclosure control. Name it for the row
   * it belongs to: a list of rows sharing one label produces a list of
   * identically-named buttons that a screen reader cannot tell apart.
   * Required whenever `collapsible` is `"chevron"`.
   */
  collapsibleLabel?: string
  /** Open state of a collapsible `submenu`, for host-controlled disclosure. */
  open?: boolean
  /**
   * Initial open state of a collapsible `submenu` when the host does not
   * control `open`.
   * @defaultValue false
   */
  defaultOpen?: boolean
  /** Called with the next open state whenever the disclosure is operated. */
  onOpenChange?: (open: boolean) => void
  /**
   * Default accessible label and native title for the control. Explicit
   * `aria-label` or `title` properties take precedence.
   */
  tooltip?: string
  /** Optional controls or supplementary content displayed at the row's trailing edge. */
  trailing?: React.ReactNode
  /**
   * Visual treatment applied to the row control.
   * @defaultValue "default"
   */
  variant?: VariantProps<typeof sidebarMenuItemVariants>["variant"]
  /**
   * Minimum height and typography scale applied to the row control.
   * @defaultValue "default"
   */
  size?: VariantProps<typeof sidebarMenuItemVariants>["size"]
  /**
   * Whether the row reserves additional logical-start space before its content.
   * @defaultValue false
   */
  inset?: VariantProps<typeof sidebarMenuItemVariants>["inset"]
}

/**
 * Renders the disclosure chevron for a collapsible row.
 *
 * The glyph points down when open and toward the inline end when closed.
 * Closed rotates a down-chevron rather than mirroring it, so the direction
 * stays correct under RTL without a scale transform fighting the rotation.
 *
 * @param props - Whether the disclosure it belongs to is open.
 * @returns A decorative chevron that rotates with the disclosure state.
 */
function SidebarMenuItemChevron({ open }: { open: boolean }) {
  return (
    <ChevronDown
      aria-hidden="true"
      className={cn(
        "size-4 shrink-0 transition-transform duration-150 group-data-[state=collapsed]/sidebar:hidden",
        // Both directions are scoped so neither has to out-order the other:
        // an unscoped `-rotate-90` wins over `rtl:rotate-90` on source order
        // and leaves a closed chevron pointing the wrong way under RTL.
        !open && "ltr:-rotate-90 rtl:rotate-90",
      )}
    />
  )
}

/**
 * Renders a complete Sidebar navigation row and any associated trailing or nested content.
 *
 * Rows are memoized: in long lists, pass referentially stable slot elements
 * and event handlers (hoisted or wrapped in useCallback) so unchanged rows
 * skip re-rendering.
 *
 * @param props - Row content, state, presentation variants, optional slots, and native button properties.
 * @returns A semantic list item containing its interactive control and optional supplementary content.
 */
const SidebarMenuItem = React.memo(function SidebarMenuItem({
  asChild = false,
  badge,
  children,
  collapsedIcon,
  collapsible,
  collapsibleLabel = "Toggle submenu",
  defaultOpen = false,
  onOpenChange,
  open: controlledOpen,
  containerClassName,
  description,
  icon,
  isActive = false,
  showTrailingOnHover = false,
  submenu,
  tooltip,
  trailing,
  variant,
  size,
  inset,
  className,
  ...props
}: SidebarMenuItemProps) {
  // A submenu is only a disclosure when the host asks for one; without
  // `collapsible` the submenu renders exactly as before, always open and
  // carrying no disclosure semantics.
  const isCollapsible = collapsible != null && submenu != null
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen)
  const open = controlledOpen ?? uncontrolledOpen
  const generatedSubmenuId = React.useId()
  const submenuId = `${generatedSubmenuId}-submenu`
  /**
   * Flips the disclosure, reporting the next state to the host and owning it
   * locally only while the host does not.
   *
   * @returns Nothing; the next open state is reported through `onOpenChange`.
   */
  const toggleOpen = React.useCallback(() => {
    const next = !open
    if (controlledOpen === undefined) setUncontrolledOpen(next)
    onOpenChange?.(next)
  }, [controlledOpen, onOpenChange, open])

  const Comp = asChild ? Slot.Root : "button"
  const label =
    asChild && React.isValidElement<{ children?: React.ReactNode }>(children)
      ? children.props.children
      : children
  const hasTrailing = Boolean(badge || trailing)
  // A row with both a badge and hover-revealed trailing swaps one for the
  // other in a single cell rather than hiding the badge along with the
  // action: the count is the row's resting information, and revealing an
  // action should not cost the reader that.
  const swapsBadge = showTrailingOnHover && Boolean(badge) && Boolean(trailing)
  // The trailing region is a band as tall as the row's own first line, so
  // its content centres against the row whatever height that content is —
  // a 14px spinner and a 28px icon button both land on the row's midline.
  // The band's height mirrors the control's `min-h-*`, and is read from the
  // same `size` prop rather than from `:has()`, which would match a nested
  // submenu's rows and let a child row's size move its parent's trailing.
  const trailingBandClassName =
    size === "sm" ? "h-8" : size === "lg" ? "h-12" : "h-9"
  const content = (
    <>
      {isCollapsible && collapsible === "row" ? (
        <SidebarMenuItemChevron open={open} />
      ) : null}
      {icon ? (
        <span
          aria-hidden="true"
          className={cn(
            "inline-flex shrink-0 items-center [&>svg]:size-4",
            collapsedIcon && "group-data-[state=collapsed]/sidebar:hidden",
          )}
        >
          {icon}
        </span>
      ) : null}
      {collapsedIcon ? (
        <span
          aria-hidden="true"
          className="hidden shrink-0 group-data-[state=collapsed]/sidebar:inline-flex [&>svg]:size-4"
        >
          {collapsedIcon}
        </span>
      ) : null}
      <span
        data-slot="sidebar-menu-item-content"
        className="flex min-w-0 flex-1 flex-col items-start justify-center gap-0.5 overflow-hidden group-data-[state=collapsed]/sidebar:absolute group-data-[state=collapsed]/sidebar:size-px group-data-[state=collapsed]/sidebar:overflow-hidden group-data-[state=collapsed]/sidebar:whitespace-nowrap group-data-[state=collapsed]/sidebar:[clip-path:inset(50%)]"
      >
        <span data-slot="sidebar-menu-item-label" className="w-full truncate">
          {label}
        </span>
        {description ? (
          <span
            data-slot="sidebar-menu-item-description"
            className="w-full truncate nessa-text-2 font-normal text-sidebar-foreground/60"
          >
            {description}
          </span>
        ) : null}
      </span>
    </>
  )

  // In `"row"` mode the row control is the disclosure, so it carries the
  // disclosure semantics and toggles after any handler the host passed —
  // and only if that handler did not preventDefault.
  const rowDisclosureProps =
    isCollapsible && collapsible === "row"
      ? {
          "aria-expanded": open,
          "aria-controls": submenuId,
          onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
            props.onClick?.(event)
            if (!event.defaultPrevented) toggleOpen()
          },
        }
      : null

  const control = (
    <Comp
      type={asChild ? undefined : "button"}
      data-slot="sidebar-menu-item-control"
      data-active={isActive}
      data-size={size ?? "default"}
      aria-label={tooltip}
      title={tooltip}
      className={cn(
        sidebarMenuItemVariants({
          variant,
          size,
          // A `"chevron"` disclosure sits in the row's logical-start space,
          // so the row reserves that space the same way `inset` does.
          inset: isCollapsible && collapsible === "chevron" ? true : inset,
        }),
        className,
      )}
      {...props}
      {...rowDisclosureProps}
    >
      {asChild && React.isValidElement(children)
        ? React.cloneElement(children, undefined, content)
        : content}
    </Comp>
  )

  return (
    <li
      data-slot="sidebar-menu-item"
      data-state={isCollapsible ? (open ? "open" : "closed") : undefined}
      className={cn("relative min-w-0", containerClassName)}
    >
      {/* The row's own scope. `group/menu-item` compiles to a descendant
          match, so a submenu nested inside the scope would let a child row's
          hover or focus drive the parent's reveal, swap and trailing pad —
          the parent swapping its badge for its action while the pointer is
          two rows away. The submenu stays outside this element. */}
      <div
        data-slot="sidebar-menu-item-row"
        data-has-trailing={hasTrailing || undefined}
        className="group/menu-item relative min-w-0"
      >
      {isCollapsible && collapsible === "chevron" ? (
        <button
          type="button"
          data-slot="sidebar-menu-item-disclosure"
          aria-expanded={open}
          aria-controls={submenuId}
          aria-label={collapsibleLabel}
          onClick={toggleOpen}
          // The 24px control centres on the same axis as a `"row"` chevron,
          // which sits inside the control's own 10px leading padding.
          className={cn(
            "absolute start-1.5 top-0 z-10 flex w-6 appearance-none items-center justify-center rounded-md border-0 bg-transparent p-0 text-sidebar-foreground/70 outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sidebar-ring group-data-[state=collapsed]/sidebar:hidden",
            trailingBandClassName,
          )}
        >
          <SidebarMenuItemChevron open={open} />
        </button>
      ) : null}
      {control}
      {hasTrailing ? (
        <div
          data-slot="sidebar-menu-item-trailing"
          data-show-on-hover={showTrailingOnHover || undefined}
          className={cn(
            "absolute end-1 top-0 z-10 flex items-center gap-0.5 group-data-[nested=true]/menu:h-8 group-data-[state=collapsed]/sidebar:hidden",
            trailingBandClassName,
            showTrailingOnHover && !swapsBadge && sidebarMenuRevealClassName,
          )}
        >
          {swapsBadge ? (
            <span className={sidebarMenuSwapClassName}>
              <span
                data-slot="sidebar-menu-item-badge"
                className={cn(
                  sidebarMenuBadgeClassName,
                  "[@media(hover:hover)_and_(pointer:fine)]:col-start-1 [@media(hover:hover)_and_(pointer:fine)]:row-start-1",
                  sidebarMenuSwapRestClassName,
                )}
              >
                {badge}
              </span>
              <span
                className={cn(
                  "flex items-center gap-0.5 transition-opacity [@media(hover:hover)_and_(pointer:fine)]:col-start-1 [@media(hover:hover)_and_(pointer:fine)]:row-start-1",
                  sidebarMenuRevealClassName,
                )}
              >
                {trailing}
              </span>
            </span>
          ) : (
            <>
              {badge ? (
                <span
                  data-slot="sidebar-menu-item-badge"
                  className={sidebarMenuBadgeClassName}
                >
                  {badge}
                </span>
              ) : null}
              {trailing}
            </>
          )}
        </div>
      ) : null}
      </div>
      {isCollapsible ? (
        // The wrapper always renders so `aria-controls` always names a real
        // element; `hidden` closes it without discarding the subtree's own
        // state. A closed disclosure keeps its rows out of the a11y tree.
        <div
          id={submenuId}
          data-slot="sidebar-menu-item-submenu"
          hidden={!open}
        >
          {submenu}
        </div>
      ) : (
        submenu
      )}
    </li>
  )
})

// Loading row

/**
 * Derives a stable pseudo-random skeleton width from a component identity.
 *
 * @param seed - A stable identifier shared between server and client renders.
 * @returns A percentage width between 50% and 90% inclusive.
 */
function skeletonWidthFromSeed(seed: string) {
  let hash = 0

  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 41
  }

  return `${50 + hash}%`
}

/** Properties accepted by a Sidebar menu loading row. */
interface SidebarMenuSkeletonProps extends React.ComponentProps<"li"> {
  /**
   * Whether to reserve and display a leading icon placeholder.
   * @defaultValue false
   */
  showIcon?: boolean
}

/**
 * Renders a non-interactive loading placeholder for a Sidebar menu row.
 *
 * @param props - Native list-item properties and optional icon-placeholder visibility.
 * @returns A semantic list item containing animated loading placeholders.
 */
function SidebarMenuSkeleton({
  className,
  showIcon = false,
  ...props
}: SidebarMenuSkeletonProps) {
  const skeletonId = React.useId()
  const skeletonWidth = skeletonWidthFromSeed(skeletonId)

  return (
    <li
      data-slot="sidebar-menu-skeleton"
      className={cn(
        "flex min-h-9 items-center gap-2.5 rounded-lg px-2.5 group-data-[state=collapsed]/sidebar:justify-center group-data-[state=collapsed]/sidebar:px-0 group-data-[state=collapsed]/sidebar:not-has-[[data-sidebar=menu-skeleton-icon]]:hidden",
        className,
      )}
      {...props}
    >
      {showIcon ? (
        <span
          data-sidebar="menu-skeleton-icon"
          className="size-4 shrink-0 animate-pulse rounded-sm bg-sidebar-accent"
        />
      ) : null}
      <span
        data-sidebar="menu-skeleton-text"
        className="h-4 max-w-(--skeleton-width) flex-1 animate-pulse rounded-sm bg-sidebar-accent group-data-[state=collapsed]/sidebar:hidden"
        style={{ "--skeleton-width": skeletonWidth } as React.CSSProperties}
      />
    </li>
  )
}

export {
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  sidebarMenuItemVariants,
  type SidebarMenuItemProps,
  type SidebarMenuProps,
  type SidebarMenuSkeletonProps,
}
