"use client"

import * as React from "react"
import { Check, ChevronDown } from "lucide-react"
import { Direction, Popover } from "radix-ui"

import {
  SearchableListbox,
  type SearchableListboxRenderState,
} from "./searchable-listbox"
import { cn } from "@/lib/utils"

/** Describes one selectable model in a provider catalog. */
export interface ModelPickerModel {
  id: string
  label: string
  description?: string
  icon?: React.ReactNode
  disabled?: boolean
}

/** Describes one provider and its model catalog. */
export interface ModelPickerGroup {
  id: string
  label: string
  shortLabel?: string
  icon?: React.ReactNode
  disabled?: boolean
  models: ModelPickerModel[]
}

/** Identifies a selected model by provider and model IDs. */
export interface ModelPickerValue {
  providerId: string
  modelId: string
}

/** Configures the provider-aware model-selection popover. */
export interface ModelPickerProps {
  ref?: React.Ref<HTMLButtonElement>
  groups: ModelPickerGroup[]
  value?: ModelPickerValue
  defaultValue?: ModelPickerValue
  onValueChange?: (value: ModelPickerValue) => void
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyMessage?: string
  loading?: boolean
  disabled?: boolean
  className?: string
  contentClassName?: string
  portalContainer?: HTMLElement | null
  side?: React.ComponentProps<typeof Popover.Content>["side"]
  align?: React.ComponentProps<typeof Popover.Content>["align"]
  sideOffset?: number
  dir?: "ltr" | "rtl"
  triggerLabel?: string
  contentLabel?: string
  listLabel?: string
  tabsLabel?: string
  loadingMessage?: React.ReactNode
}

interface ResolvedModel {
  group: ModelPickerGroup
  model: ModelPickerModel
}

interface ModelPickerItem extends ResolvedModel {
  value: ModelPickerValue
}

interface ModelPickerRowProps extends ResolvedModel {
  selected: boolean
}

/** Resolves a catalog entry for a provider/model value pair. */
function findModel(
  groups: ModelPickerGroup[],
  value: ModelPickerValue | undefined,
): ResolvedModel | undefined {
  if (!value) return undefined
  const group = groups.find((candidate) => candidate.id === value.providerId)
  const model = group?.models.find((candidate) => candidate.id === value.modelId)
  return group && model ? { group, model } : undefined
}

/** Returns all provider and model strings searched for a model item. */
function modelItemKeywords(item: ModelPickerItem) {
  return [
    item.group.label,
    item.group.shortLabel,
    item.model.label,
    item.model.description,
  ]
}

/** Returns whether a model or its provider contains the normalized query. */
function modelMatchesSearch(
  group: ModelPickerGroup,
  model: ModelPickerModel,
  normalizedQuery: string,
) {
  if (!normalizedQuery) return true
  return modelItemKeywords({
    group,
    model,
    value: { providerId: group.id, modelId: model.id },
  }).some((keyword) =>
    keyword?.toLocaleLowerCase().includes(normalizedQuery),
  )
}

/** Produces a collision-free key for a provider/model tuple. */
function modelTupleKey(providerId: string, modelId: string) {
  return JSON.stringify([providerId, modelId])
}

/** Returns the stable searchable-listbox value for a model item. */
function modelItemId(item: ModelPickerItem) {
  return modelTupleKey(item.value.providerId, item.value.modelId)
}

/** Returns whether either the owning provider or model disables selection. */
function modelItemDisabled(item: ModelPickerItem) {
  return Boolean(item.group.disabled || item.model.disabled)
}

/** Chooses the preferred enabled provider or the best available fallback. */
function resolveActiveProviderId(
  groups: ModelPickerGroup[],
  preferredProviderId?: string,
) {
  const preferred = groups.find((group) => group.id === preferredProviderId)
  if (preferred && !preferred.disabled) return preferred.id
  return (
    groups.find((group) => !group.disabled)?.id ??
    preferred?.id ??
    groups[0]?.id
  )
}

/** Renders model-specific content inside a searchable-listbox option. */
function ModelPickerRow({ group, model, selected }: ModelPickerRowProps) {
  return (
    <span className="grid w-full grid-cols-[2rem_minmax(0,1fr)_1.25rem] items-center gap-2">
      <span
        aria-hidden="true"
        className="flex size-8 items-center justify-center rounded-full bg-background text-foreground shadow-xs [&_svg]:size-4"
      >
        {model.icon ?? group.icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate nessa-text-4 font-medium">{model.label}</span>
        {model.description ? (
          <span className="block truncate nessa-text-2 text-muted-foreground">
            {model.description}
          </span>
        ) : null}
      </span>
      {selected ? <Check aria-hidden="true" className="size-4" /> : null}
    </span>
  )
}

/** Renders a provider-aware searchable model picker. */
function ModelPicker({
  ref,
  groups,
  value: valueProp,
  defaultValue,
  onValueChange,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  placeholder = "Select model",
  searchPlaceholder = "Search models",
  emptyMessage = "No models found",
  loading = false,
  disabled = false,
  className,
  contentClassName,
  portalContainer,
  side = "top",
  align = "end",
  sideOffset = 0,
  dir,
  triggerLabel,
  contentLabel = "Choose a model",
  listLabel = "Available models",
  tabsLabel = "Model providers",
  loadingMessage = "Loading models",
}: ModelPickerProps) {
  const effectiveDir = Direction.useDirection(dir)
  const [uncontrolledValue, setUncontrolledValue] =
    React.useState<ModelPickerValue | undefined>(defaultValue)
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen)
  const [query, setQuery] = React.useState("")
  const value = valueProp ?? uncontrolledValue
  const open = openProp ?? uncontrolledOpen
  const resolved = findModel(groups, value)
  const pickerId = React.useId()
  const initialActiveProviderId = resolveActiveProviderId(
    groups,
    resolved?.group.id,
  )
  const activeProviderIsCatalogFallbackRef = React.useRef(
    initialActiveProviderId !== resolved?.group.id,
  )
  const [activeProviderId, setActiveProviderId] = React.useState(
    initialActiveProviderId,
  )
  const previousControlledValueRef = React.useRef(valueProp)
  const previousOpenRef = React.useRef(open)
  const providerTabRefs = React.useRef(new Map<string, HTMLButtonElement>())
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const matchingGroups = groups.filter((group) =>
    group.models.some((model) =>
      modelMatchesSearch(group, model, normalizedQuery),
    ),
  )
  const hasEnabledProvider = groups.some((group) => !group.disabled)
  const firstMatchingProviderId =
    matchingGroups.find((group) => !group.disabled)?.id ??
    (!hasEnabledProvider ? matchingGroups[0]?.id : undefined)
  const catalogProviderId = resolveActiveProviderId(groups, activeProviderId)
  const catalogProvider =
    groups.find((group) => group.id === catalogProviderId) ??
    groups.find((group) => !group.disabled) ??
    groups[0]
  const catalogProviderHasMatches = Boolean(
    catalogProvider?.models.some((model) =>
      modelMatchesSearch(catalogProvider, model, normalizedQuery),
    ),
  )
  const searchRoutedProviderId =
    normalizedQuery && !catalogProviderHasMatches && firstMatchingProviderId
      ? firstMatchingProviderId
      : catalogProviderId
  const activeProvider =
    groups.find((group) => group.id === searchRoutedProviderId) ??
    groups.find((group) => !group.disabled) ??
    groups[0]
  const visibleItems: ModelPickerItem[] = activeProvider
    ? activeProvider.models.map((model) => ({
        group: activeProvider,
        model,
        value: { providerId: activeProvider.id, modelId: model.id },
      }))
    : []

  React.useEffect(() => {
    const activeProviderIsSelectable = groups.some(
      (group) => group.id === activeProviderId && !group.disabled,
    )
    const selectedProviderBecameAvailable = Boolean(
      activeProviderIsCatalogFallbackRef.current && resolved,
    )
    if (activeProviderIsSelectable && !selectedProviderBecameAvailable) return
    const nextProviderId = resolveActiveProviderId(groups, resolved?.group.id)
    activeProviderIsCatalogFallbackRef.current =
      nextProviderId !== resolved?.group.id
    if (nextProviderId !== activeProviderId) {
      setActiveProviderId(nextProviderId)
    }
  }, [activeProviderId, groups, resolved?.group.id])

  React.useEffect(() => {
    const previousValue = previousControlledValueRef.current
    const wasOpen = previousOpenRef.current
    previousControlledValueRef.current = valueProp
    previousOpenRef.current = open
    const controlledValueChanged =
      previousValue?.providerId !== valueProp?.providerId ||
      previousValue?.modelId !== valueProp?.modelId
    const controlledPickerOpened = !wasOpen && open
    if (
      !open ||
      !valueProp ||
      (!controlledValueChanged && !controlledPickerOpened)
    ) {
      return
    }
    const nextProviderId = resolveActiveProviderId(groups, valueProp.providerId)
    activeProviderIsCatalogFallbackRef.current =
      nextProviderId !== findModel(groups, valueProp)?.group.id
    setActiveProviderId(nextProviderId)
  }, [groups, open, valueProp])

  React.useEffect(() => {
    if (!normalizedQuery || searchRoutedProviderId === activeProviderId) return
    activeProviderIsCatalogFallbackRef.current = false
    setActiveProviderId(searchRoutedProviderId)
  }, [
    activeProviderId,
    normalizedQuery,
    searchRoutedProviderId,
  ])

  /** Updates open state and resets transient search state when the picker closes. */
  const setOpen = React.useCallback(
    (nextOpen: boolean) => {
      if (openProp === undefined) setUncontrolledOpen(nextOpen)
      if (!nextOpen) {
        setQuery("")
      } else {
        const nextProviderId = resolveActiveProviderId(groups, resolved?.group.id)
        activeProviderIsCatalogFallbackRef.current =
          nextProviderId !== resolved?.group.id
        setActiveProviderId(nextProviderId)
      }
      onOpenChange?.(nextOpen)
    },
    [groups, onOpenChange, openProp, resolved?.group.id],
  )

  /** Commits a model value through controlled or uncontrolled ownership. */
  const commitValue = React.useCallback(
    (nextValue: ModelPickerValue) => {
      if (valueProp === undefined) setUncontrolledValue(nextValue)
      onValueChange?.(nextValue)
    },
    [onValueChange, valueProp],
  )

  /** Selects an enabled model and closes the picker. */
  const selectModel = React.useCallback(
    (_itemId: string, item: ModelPickerItem) => {
      if (modelItemDisabled(item)) return
      activeProviderIsCatalogFallbackRef.current = false
      setActiveProviderId(item.group.id)
      commitValue(item.value)
      setOpen(false)
    },
    [commitValue, setOpen],
  )

  const enabledProviderIds = groups
    .filter((group) => !group.disabled)
    .map((group) => group.id)
  const matchingSelectableProviderIds = groups
    .filter(
      (group) =>
        !group.disabled &&
        group.models.some((model) =>
          modelMatchesSearch(group, model, normalizedQuery),
        ),
    )
    .map((group) => group.id)
  const selectableProviderIds =
    normalizedQuery && matchingSelectableProviderIds.length > 0
      ? matchingSelectableProviderIds
      : enabledProviderIds

  /** Activates an enabled provider without changing the selected model. */
  const activateProvider = React.useCallback(
    (providerId: string) => {
      if (!groups.some((group) => group.id === providerId && !group.disabled)) {
        return
      }
      if (!selectableProviderIds.includes(providerId)) return
      activeProviderIsCatalogFallbackRef.current = false
      setActiveProviderId(providerId)
    },
    [groups, selectableProviderIds],
  )

  /** Handles horizontal roving focus across enabled provider tabs. */
  const handleProviderNavigation = React.useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, providerId: string) => {
      if (
        event.key !== "ArrowLeft" &&
        event.key !== "ArrowRight" &&
        event.key !== "Home" &&
        event.key !== "End"
      ) return
      if (selectableProviderIds.length === 0) return
      event.preventDefault()
      const currentIndex = selectableProviderIds.indexOf(providerId)
      const movesForward =
        (event.key === "ArrowRight" && effectiveDir === "ltr") ||
        (event.key === "ArrowLeft" && effectiveDir === "rtl")
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? selectableProviderIds.length - 1
          : movesForward
          ? (currentIndex + 1) % selectableProviderIds.length
          : (currentIndex - 1 + selectableProviderIds.length) %
            selectableProviderIds.length
      const nextProviderId = selectableProviderIds[nextIndex]
      if (!nextProviderId) return
      activateProvider(nextProviderId)
      providerTabRefs.current.get(nextProviderId)?.focus()
    },
    [activateProvider, effectiveDir, selectableProviderIds],
  )

  /** Returns the accessible tab ID for a provider. */
  const providerTabId = (providerId: string) =>
    `${pickerId}-provider-${encodeURIComponent(providerId)}-tab`
  const providerPanelId = `${pickerId}-provider-panel`
  const selectedItemId = value
    ? modelTupleKey(value.providerId, value.modelId)
    : undefined

  /** Renders model-specific row content for the shared listbox. */
  const renderModelItem = React.useCallback(
    (item: ModelPickerItem, state: SearchableListboxRenderState) => (
      <ModelPickerRow
        group={item.group}
        model={item.model}
        selected={state.selected}
      />
    ),
    [],
  )

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          ref={ref}
          type="button"
          data-slot="model-picker-trigger"
          disabled={disabled}
          aria-label={triggerLabel ?? (
            resolved
              ? `Change model, currently ${resolved.model.label}`
              : "Choose model"
          )}
          className={cn(
            "inline-flex h-9 min-w-9 max-w-72 shrink items-center gap-1.5 rounded-full px-3 font-sans nessa-text-4 font-medium text-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:[outline-style:solid] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50",
            className,
          )}
        >
          {resolved?.model.icon ? (
            <span
              aria-hidden="true"
              className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-4"
            >
              {resolved.model.icon}
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate">
            {resolved?.model.label ?? placeholder}
          </span>
          <ChevronDown
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted-foreground"
          />
        </button>
      </Popover.Trigger>
      <Popover.Portal container={portalContainer}>
        <Popover.Content
          data-slot="model-picker-content"
          aria-label={contentLabel}
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={12}
          dir={effectiveDir}
          className={cn(
            "z-50 w-[min(24rem,calc(100vw-1.5rem))] overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-xl outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            contentClassName,
          )}
        >
          <div data-slot="model-picker-models" className="min-w-0">
            <div
              role={activeProvider ? "tabpanel" : undefined}
              id={activeProvider ? providerPanelId : undefined}
              aria-labelledby={
                activeProvider ? providerTabId(activeProvider.id) : undefined
              }
            >
              <SearchableListbox
                items={visibleItems}
                getItemId={modelItemId}
                getItemKeywords={modelItemKeywords}
                renderItem={renderModelItem}
                value={selectedItemId}
                onValueChange={selectModel}
                query={query}
                onQueryChange={setQuery}
                isItemDisabled={modelItemDisabled}
                searchPlaceholder={searchPlaceholder}
                listLabel={listLabel}
                emptyMessage={emptyMessage}
                loading={loading}
                loadingMessage={loadingMessage}
              />
            </div>
            {groups.length > 0 ? (
              <div
                data-slot="model-picker-provider-tabs"
                role="tablist"
                aria-label={tabsLabel}
                className="flex min-h-11 items-center gap-1 overflow-x-auto border-t border-border bg-muted/35 p-1.5"
              >
                {groups.map((group) => {
                  const selected = group.id === activeProvider?.id
                  const providerEligible = selectableProviderIds.includes(group.id)
                  return (
                    <button
                      key={group.id}
                      ref={(node) => {
                        if (node) providerTabRefs.current.set(group.id, node)
                        else providerTabRefs.current.delete(group.id)
                      }}
                      type="button"
                      id={providerTabId(group.id)}
                      role="tab"
                      aria-label={group.label}
                      aria-selected={selected}
                      aria-controls={providerPanelId}
                      tabIndex={selected ? 0 : -1}
                      disabled={!providerEligible}
                      onClick={() => activateProvider(group.id)}
                      onKeyDown={(event) =>
                        handleProviderNavigation(event, group.id)
                      }
                      className={cn(
                        "inline-flex h-8 min-w-8 shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-lg px-2.5 font-sans nessa-text-2 font-medium text-muted-foreground outline-none transition-[color,background-color,box-shadow] hover:text-foreground focus-visible:[outline-style:solid] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-45",
                        selected && "bg-background text-foreground shadow-xs",
                      )}
                    >
                      {group.icon ? (
                        <span
                          aria-hidden="true"
                          className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-4"
                        >
                          {group.icon}
                        </span>
                      ) : null}
                      {selected || !group.icon ? (
                        group.shortLabel ?? group.label
                      ) : (
                        <span className="sr-only">{group.label}</span>
                      )}
                    </button>
                  )
                })}
              </div>
            ) : null}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

export { ModelPicker }
