import * as React from "react"
import { LoaderCircle, Search } from "lucide-react"

import { cn } from "@/lib/utils"

/** Describes the selection and focus state supplied to an item renderer. */
export interface SearchableListboxRenderState {
  selected: boolean
  highlighted: boolean
}

/** Configures a searchable, single-select list while leaving item content to the consumer. */
export interface SearchableListboxProps<Item> {
  ref?: React.Ref<HTMLDivElement>
  /** Records presented and filtered by the listbox. */
  items: readonly Item[]
  /** Returns a stable ID that is unique within this listbox instance. */
  getItemId: (item: Item) => string
  /** Returns every string that should participate in case-insensitive search. */
  getItemKeywords: (item: Item) => readonly (string | undefined)[]
  /** Renders non-interactive row content inside the component-owned option. */
  renderItem: (
    item: Item,
    state: SearchableListboxRenderState,
  ) => React.ReactNode
  /** The selected item ID. */
  value?: string
  onValueChange?: (value: string, item: Item) => void
  query?: string
  defaultQuery?: string
  onQueryChange?: (query: string) => void
  isItemDisabled?: (item: Item) => boolean
  searchPlaceholder?: string
  /** The accessible name announced for the list of matching options. */
  listLabel: string
  emptyMessage?: React.ReactNode
  loading?: boolean
  loadingMessage?: React.ReactNode
  disabled?: boolean
  className?: string
  searchClassName?: string
  listClassName?: string
  optionClassName?: string
}

/** Returns whether an item contains a normalized query in any searchable keyword. */
function itemMatchesQuery<Item>(
  item: Item,
  normalizedQuery: string,
  getItemKeywords: SearchableListboxProps<Item>["getItemKeywords"],
) {
  if (!normalizedQuery) return true
  return getItemKeywords(item).some((keyword) =>
    keyword?.toLocaleLowerCase().includes(normalizedQuery),
  )
}

/**
 * Renders a searchable single-select listbox with controlled or uncontrolled
 * query state, roving keyboard focus, and consumer-defined row content.
 */
function SearchableListbox<Item>({
  ref,
  items,
  getItemId,
  getItemKeywords,
  renderItem,
  value,
  onValueChange,
  query: queryProp,
  defaultQuery = "",
  onQueryChange,
  isItemDisabled = () => false,
  searchPlaceholder = "Search",
  listLabel,
  emptyMessage = "No results found",
  loading = false,
  loadingMessage = "Loading",
  disabled = false,
  className,
  searchClassName,
  listClassName,
  optionClassName,
}: SearchableListboxProps<Item>) {
  const [uncontrolledQuery, setUncontrolledQuery] = React.useState(defaultQuery)
  const [highlightedId, setHighlightedId] = React.useState<string>()
  const [rovingId, setRovingId] = React.useState<string>()
  const optionRefs = React.useRef(new Map<string, HTMLButtonElement>())
  const listboxId = React.useId()
  const query = queryProp ?? uncontrolledQuery
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredItems = React.useMemo(
    () =>
      items.filter((item) =>
        itemMatchesQuery(item, normalizedQuery, getItemKeywords),
      ),
    [getItemKeywords, items, normalizedQuery],
  )
  const navigableItems = filteredItems
  const firstNavigableId = navigableItems[0]
    ? getItemId(navigableItems[0])
    : undefined
  const rovingItemIsVisible = navigableItems.some(
    (item) => getItemId(item) === rovingId,
  )
  const selectedItemIsVisible = navigableItems.some(
    (item) => getItemId(item) === value,
  )
  const rovingItemId = rovingItemIsVisible
    ? rovingId
    : selectedItemIsVisible
      ? value
      : firstNavigableId

  React.useEffect(() => {
    if (
      highlightedId &&
      !navigableItems.some((item) => getItemId(item) === highlightedId)
    ) {
      setHighlightedId(undefined)
    }
  }, [getItemId, highlightedId, navigableItems])

  React.useEffect(() => {
    if (rovingId && !navigableItems.some((item) => getItemId(item) === rovingId)) {
      setRovingId(undefined)
    }
  }, [getItemId, navigableItems, rovingId])

  /** Updates the owned query when uncontrolled and always notifies the consumer. */
  const setQuery = React.useCallback(
    (nextQuery: string) => {
      if (queryProp === undefined) setUncontrolledQuery(nextQuery)
      setHighlightedId(undefined)
      setRovingId(undefined)
      onQueryChange?.(nextQuery)
    },
    [onQueryChange, queryProp],
  )

  /** Moves focus to an item, including disabled options that describe why they are unavailable. */
  const focusItem = React.useCallback(
    (index: number) => {
      const item = navigableItems[index]
      if (!item) return
      const itemId = getItemId(item)
      setHighlightedId(itemId)
      setRovingId(itemId)
      optionRefs.current.get(itemId)?.focus()
    },
    [getItemId, navigableItems],
  )

  /** Handles vertical roving focus from either the search field or an option. */
  const handleNavigation = React.useCallback(
    (event: React.KeyboardEvent, currentId?: string) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (
        event.key !== "ArrowDown" &&
        event.key !== "ArrowUp" &&
        (currentId === undefined ||
          (event.key !== "Home" && event.key !== "End"))
      ) {
        return
      }
      if (disabled || navigableItems.length === 0) return
      event.preventDefault()
      const currentIndex = currentId
        ? navigableItems.findIndex((item) => getItemId(item) === currentId)
        : -1
      const nextIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? navigableItems.length - 1
            : event.key === "ArrowDown"
          ? currentIndex < 0 || currentIndex === navigableItems.length - 1
            ? 0
            : currentIndex + 1
          : currentIndex <= 0
            ? navigableItems.length - 1
            : currentIndex - 1
      focusItem(nextIndex)
    },
    [disabled, focusItem, getItemId, navigableItems],
  )

  return (
    <div ref={ref} data-slot="searchable-listbox" className={cn("min-w-0", className)}>
      <label
        data-slot="searchable-listbox-search"
        className={cn(
          // The search row owns the focus treatment for the field it wraps,
          // because the bare input must not paint an outline of its own.
          "flex h-11 items-center gap-2 border-b border-border px-3 text-muted-foreground transition-colors focus-within:bg-accent/50 focus-within:text-foreground",
          searchClassName,
        )}
      >
        <Search aria-hidden="true" className="size-4 shrink-0" />
        <span className="sr-only">{searchPlaceholder}</span>
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.preventDefault()
              event.stopPropagation()
              setQuery("")
              return
            }
            handleNavigation(event)
          }}
          placeholder={searchPlaceholder}
          autoComplete="off"
          disabled={disabled}
          aria-controls={listboxId}
          // The field carries no outline of its own: browsers match
          // :focus-visible on editable fields for pointer focus too, so an
          // outline here reads as a permanent box around the search row for as
          // long as the surface is open. The caret indicates focus, and the
          // wrapping row owns the surface treatment.
          className="h-full min-w-0 flex-1 appearance-none bg-transparent font-sans nessa-text-4 text-foreground outline-none placeholder:text-muted-foreground disabled:pointer-events-none disabled:opacity-50"
        />
      </label>
      <div
        data-slot="searchable-listbox-list"
        id={listboxId}
        role={!loading && filteredItems.length > 0 ? "listbox" : undefined}
        aria-label={!loading && filteredItems.length > 0 ? listLabel : undefined}
        className={cn("max-h-80 overflow-y-auto p-1.5", listClassName)}
        onPointerLeave={() => setHighlightedId(undefined)}
      >
        {loading ? (
          <div
            data-slot="searchable-listbox-loading"
            className="flex min-h-28 items-center justify-center gap-2 px-3 nessa-text-4 text-muted-foreground"
            role="status"
          >
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
            {loadingMessage}
          </div>
        ) : filteredItems.length > 0 ? (
          <div className="flex flex-col gap-0.5">
            {filteredItems.map((item) => {
              const itemId = getItemId(item)
              const selected = value === itemId
              const highlighted = highlightedId === itemId
              const itemDisabled = disabled || isItemDisabled(item)
              return (
                <button
                  key={itemId}
                  type="button"
                  ref={(node) => {
                    if (node) optionRefs.current.set(itemId, node)
                    else optionRefs.current.delete(itemId)
                  }}
                  id={`${listboxId}-option-${encodeURIComponent(itemId)}`}
                  role="option"
                  aria-selected={selected}
                  tabIndex={!disabled && rovingItemId === itemId ? 0 : -1}
                  data-slot="searchable-listbox-option"
                  data-selected={selected ? "true" : "false"}
                  data-highlighted={highlighted ? "true" : "false"}
                  aria-disabled={itemDisabled || undefined}
                  onPointerMove={() => {
                    if (!itemDisabled) setHighlightedId(itemId)
                  }}
                  onFocus={() => {
                    setHighlightedId(itemId)
                    setRovingId(itemId)
                  }}
                  onKeyDown={(event) => handleNavigation(event, itemId)}
                  onClick={() => {
                    if (!itemDisabled) onValueChange?.(itemId, item)
                  }}
                  className={cn(
                    // Rows carry real padding and a text level by default so a
                    // bare renderItem gets a finished row; content-styled
                    // consumers strip it back via optionClassName.
                    "w-full rounded-2xl px-2.5 py-2 text-start font-sans nessa-text-4 outline-none transition-colors focus-visible:bg-accent focus-visible:[outline-style:solid] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-disabled:opacity-45",
                    highlighted && "bg-accent/70",
                    optionClassName,
                  )}
                >
                  {renderItem(item, { selected, highlighted })}
                </button>
              )
            })}
          </div>
        ) : (
          <div
            data-slot="searchable-listbox-empty"
            className="flex min-h-28 items-center justify-center px-3 nessa-text-4 text-muted-foreground"
            role="status"
          >
            {emptyMessage}
          </div>
        )}
      </div>
    </div>
  )
}

export { SearchableListbox }
