import * as React from "react"
import { BrainCircuit, ChevronRight, Zap } from "lucide-react"
import { Direction, Popover, Slider } from "radix-ui"

import type { ModelThinkingLevel } from "./model-capabilities"
import { cn } from "@/lib/utils"

export type ModelThinkingIconProps = React.ComponentProps<"svg">
export type ModelFastModeIconProps = React.ComponentProps<"svg"> & {
  active?: boolean
}

/** Renders the redistributable default Fast-mode icon. */
function ModelFastModeIcon({
  active = false,
  className,
  ...props
}: ModelFastModeIconProps) {
  return <Zap className={cn("size-4.5", className)} fill={active ? "currentColor" : "none"} {...props} />
}

/** Renders the redistributable default thinking-capability icon. */
function ModelThinkingIcon({ className, ...props }: ModelThinkingIconProps) {
  return <BrainCircuit className={cn("size-4", className)} {...props} />
}

export interface ModelFastModeProps
  extends Omit<
    React.ComponentPropsWithRef<"button">,
    "aria-pressed" | "onChange" | "onClick" | "type"
  > {
  pressed: boolean
  onPressedChange: (pressed: boolean) => void
  /** Optional product-owned icon; render functions can expose a non-color pressed cue. */
  icon?: React.ReactNode | ((state: { pressed: boolean }) => React.ReactNode)
  onClick?: React.MouseEventHandler<HTMLButtonElement>
}

/** Renders the immediate Fast capability toggle. */
function ModelFastMode({
  pressed,
  onPressedChange,
  icon,
  onClick,
  className,
  disabled,
  ref,
  "aria-label": ariaLabel,
  ...props
}: ModelFastModeProps) {
  const renderedIcon = typeof icon === "function" ? icon({ pressed }) : icon

  return (
    <button
      ref={ref}
      {...props}
      type="button"
      data-slot="model-fast-mode"
      data-model-capability-control="fast"
      aria-label={ariaLabel ?? "Fast mode"}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented) onPressedChange(!pressed)
      }}
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-transparent text-muted-foreground outline-none transition-colors [transition-duration:var(--nessa-motion-duration-fast)] [transition-timing-function:var(--nessa-motion-easing-standard)] hover:bg-transparent focus-visible:[outline-style:solid] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-45 motion-reduce:transition-none",
        pressed && "text-[var(--nessa-fast-mode-active)]",
        className,
      )}
    >
      {renderedIcon ?? <ModelFastModeIcon aria-hidden="true" active={pressed} />}
    </button>
  )
}

export interface ModelThinkingControlProps {
  ref?: React.Ref<HTMLButtonElement>
  levels: ModelThinkingLevel[]
  /** Optional product-owned icon. The package default remains redistributable. */
  icon?: React.ReactNode
  dir?: "ltr" | "rtl"
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  /** Fires when pointer or keyboard interaction crosses a discrete level boundary. */
  onCheckpoint?: (level: ModelThinkingLevel, index: number) => void
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  disabled?: boolean
  className?: string
  contentClassName?: string
  portalContainer?: HTMLElement | null
  side?: React.ComponentProps<typeof Popover.Content>["side"]
  align?: React.ComponentProps<typeof Popover.Content>["align"]
  /** Controls the proportional geometry of the composed thinking slider. */
  sliderSize?: ModelThinkingSliderSize
  triggerLabel?: string
  contentLabel?: string
  sliderLabel?: string
  sliderUnavailableText?: string
  getSliderValueText?: ModelThinkingValueTextFormatter
  fastMode?: {
    pressed: boolean
    onPressedChange: (pressed: boolean) => void
    icon?: ModelFastModeProps["icon"]
    disabled?: boolean
    /** Multiplies the thinking stream speed while Fast mode is active. */
    streamSpeedMultiplier?: number
  }
}

/** Resolves a catalog value to a safe level index. */
function resolveLevelIndex(levels: ModelThinkingLevel[], value?: string) {
  const index = levels.findIndex((level) => level.value === value)
  return index >= 0 ? index : 0
}

export type ModelThinkingSliderSize = "sm" | "md"

export interface ModelThinkingSliderProps {
  ref?: React.Ref<React.ComponentRef<typeof Slider.Root>>
  levels: ModelThinkingLevel[]
  value: string
  onValueChange: (value: string) => void
  /** Lets native hosts or capable browsers attach optional haptic feedback. */
  onCheckpoint?: (level: ModelThinkingLevel, index: number) => void
  dir?: "ltr" | "rtl"
  /**
   * Sets the complete slider geometry. `sm` is the compact composer default;
   * `md` preserves the original 36px treatment.
   */
  size?: ModelThinkingSliderSize
  /** Multiplies the ambient horizontal stream speed without restarting it. */
  streamSpeedMultiplier?: number
  /** Accessible name for the slider thumb. */
  sliderLabel?: string
  /** Localizes interstitial and unavailable slider value announcements. */
  getValueText?: ModelThinkingValueTextFormatter
  unavailableText?: string
  className?: string
}

export type ModelThinkingValueTextFormatter = (
  lower: ModelThinkingLevel | undefined,
  upper: ModelThinkingLevel | undefined,
) => string

const modelThinkingSliderSizeStyles: Record<
  ModelThinkingSliderSize,
  React.CSSProperties
> = {
  sm: {
    "--model-thinking-slider-size": "1.875rem",
    "--model-thinking-slider-radius": "0.677rem",
    "--model-thinking-slider-flare-size": "2.5rem",
    "--model-thinking-slider-current-inset": "1.041667rem",
    "--model-thinking-slider-current-offset": "2.5rem",
    "--model-thinking-slider-current-blur": "1.25rem",
    "--model-thinking-slider-flare-blur": "0.625rem",
    "--model-thinking-slider-drag-scale": "1.1",
  } as React.CSSProperties,
  md: {
    "--model-thinking-slider-size": "2.25rem",
    "--model-thinking-slider-radius": "0.8125rem",
    "--model-thinking-slider-flare-size": "3rem",
    "--model-thinking-slider-current-inset": "1.25rem",
    "--model-thinking-slider-current-offset": "3rem",
    "--model-thinking-slider-current-blur": "1.5rem",
    "--model-thinking-slider-flare-blur": "0.75rem",
    "--model-thinking-slider-drag-scale": "1.1",
  } as React.CSSProperties,
}

/** Converts a CSS time value to milliseconds with a safe fallback. */
function cssDurationInMilliseconds(value: string, fallback: number) {
  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return fallback
  return value.trim().endsWith("ms") ? parsed : parsed * 1000
}

const reducedMotionQuery = "(prefers-reduced-motion: reduce)"
const maxStreamSpeedMultiplier = 4

/** Clamps a consumer stream-speed multiplier to the supported range. */
function normalizeStreamSpeedMultiplier(multiplier: number) {
  return Number.isFinite(multiplier) && multiplier > 0
    ? Math.min(multiplier, maxStreamSpeedMultiplier)
    : 1
}

/** Subscribes to changes in the platform reduced-motion preference. */
function subscribeToReducedMotion(callback: () => void) {
  const query = window.matchMedia(reducedMotionQuery)
  query.addEventListener("change", callback)
  return () => query.removeEventListener("change", callback)
}

/** Reads the current reduced-motion preference for the external store. */
function getReducedMotionSnapshot() {
  return window.matchMedia(reducedMotionQuery).matches
}

/** Returns the live, server-safe reduced-motion preference. */
function useReducedMotion() {
  return React.useSyncExternalStore(
    subscribeToReducedMotion,
    getReducedMotionSnapshot,
    () => false,
  )
}

/** Internal state used to render the directional thinking-energy fill. */
interface ModelThinkingSliderFillProps {
  dir: "ltr" | "rtl"
  levelIndex: number
  levelPosition: number
  levelCount: number
  isUltra: boolean
  streamSpeedMultiplier: number
}

/**
 * Mirrors the level-progress gradient while leaving the ambient stream
 * physical; the sweep direction rides the --model-thinking-fill-angle custom
 * property so RTL flips without a second gradient.
 */
const thinkingFillGradientClass =
  "[background-image:linear-gradient(var(--model-thinking-fill-angle,90deg),color-mix(in_oklab,var(--nessa-thinking-fill-current)_58%,var(--nessa-thinking-fill-base))_0%,color-mix(in_oklab,var(--nessa-thinking-fill-base)_64%,var(--nessa-thinking-fill-current))_46%,color-mix(in_oklab,var(--nessa-thinking-fill-highlight)_62%,var(--nessa-thinking-fill-current))_100%)]"

const streamSheenTextureClass =
  "[background-image:linear-gradient(90deg,transparent_0%,color-mix(in_oklab,var(--nessa-thinking-fill-highlight)_4%,transparent)_24%,color-mix(in_oklab,var(--foreground)_14%,transparent)_50%,color-mix(in_oklab,var(--nessa-thinking-fill-highlight)_4%,transparent)_76%,transparent_100%)]"

/** Renders the reduced-motion-safe fill and ambient stream layers. */
function ModelThinkingSliderFill({
  dir,
  levelIndex,
  levelPosition,
  levelCount,
  isUltra,
  streamSpeedMultiplier,
}: ModelThinkingSliderFillProps) {
  const reducedMotion = useReducedMotion()
  const denominator = Math.max(1, levelCount - 1)
  const ordinalProgress = levelCount > 0 ? levelPosition / denominator : 0
  const streamEnergy = isUltra ? 1 : ordinalProgress * 0.72
  const streamOpacity =
    levelCount > 0 ? (isUltra ? 1 : 0.12 + streamEnergy * 0.58) : 0
  const surfaceRef = React.useRef<HTMLSpanElement>(null)
  const currentRef = React.useRef<HTMLSpanElement>(null)
  const flareRef = React.useRef<HTMLSpanElement>(null)
  const ultraStreamRef = React.useRef<HTMLSpanElement>(null)
  const ultraStreamAnimationRef = React.useRef<Animation>(null)
  const streamEnergyRef = React.useRef(streamEnergy)
  const streamOpacityRef = React.useRef(streamOpacity)
  const streamSpeedMultiplierRef = React.useRef(streamSpeedMultiplier)
  streamEnergyRef.current = streamEnergy
  streamOpacityRef.current = streamOpacity
  streamSpeedMultiplierRef.current = streamSpeedMultiplier
  const previousIndexRef = React.useRef(levelIndex)
  const sequenceRef = React.useRef(0)

  React.useLayoutEffect(() => {
    const previousIndex = previousIndexRef.current
    previousIndexRef.current = levelIndex
    if (previousIndex === levelIndex) return

    const surface = surfaceRef.current
    const current = currentRef.current
    const flare = flareRef.current
    const ultraStream = ultraStreamRef.current
    if (!surface || !current || !flare || !ultraStream) return

    const direction = levelIndex > previousIndex ? "up" : "down"
    const targetProgress = levelIndex / Math.max(1, levelCount - 1)
    const intensity = isUltra ? 1.75 : 0.75 + targetProgress * 0.75
    sequenceRef.current += 1
    surface.dataset.motionDirection = direction
    surface.dataset.motionSequence = String(sequenceRef.current)
    const checkpointEnergy = streamEnergyRef.current
    const checkpointOpacity = streamOpacityRef.current
    surface.dataset.motionTension = checkpointEnergy.toFixed(2)
    if (reducedMotion) return

    const styles = getComputedStyle(surface)
    const slowDuration = cssDurationInMilliseconds(
      styles.getPropertyValue("--nessa-motion-duration-slow"),
      300,
    )
    const duration = slowDuration * 1.6
    const easing =
      styles.getPropertyValue("--nessa-motion-easing-emphasized").trim() ||
      "cubic-bezier(0.4, 0, 0.2, 1)"
    const travel = direction === "up"
      ? dir === "rtl" ? ["18%", "-10%"] : ["-18%", "10%"]
      : dir === "rtl" ? ["-18%", "10%"] : ["18%", "-10%"]
    const flareOffset = dir === "rtl" ? "-50%" : "50%"
    const animations = [
      ultraStream.animate(
        [
          { opacity: checkpointOpacity * 0.7 },
          {
            opacity: Math.min(1, checkpointOpacity + 0.14 * intensity),
            offset: 0.48,
          },
          { opacity: checkpointOpacity },
        ],
        { duration, easing },
      ),
      current.animate(
        [
          { opacity: 0.14, transform: `translateX(${travel[0]}) scale(0.78)` },
          {
            opacity: Math.min(0.72, 0.38 + intensity * 0.18),
            transform: "translateX(0%) scale(1.08)",
            offset: 0.55,
          },
          { opacity: 0.25, transform: "translateX(0%) scale(1)" },
        ],
        { duration, easing },
      ),
      flare.animate(
        [
          { opacity: 0, transform: `translate(${flareOffset}, -50%) scale(0.35)` },
          {
            opacity: Math.min(0.9, 0.48 + intensity * 0.2),
            transform: `translate(${flareOffset}, -50%) scale(1.15)`,
            offset: 0.46,
          },
          { opacity: 0, transform: `translate(${flareOffset}, -50%) scale(1.7)` },
        ],
        { duration, easing },
      ),
    ]
    return () => {
      for (const animation of animations) animation.cancel()
    }
  }, [dir, isUltra, levelCount, levelIndex, reducedMotion])

  React.useEffect(() => {
    const ultraStream = ultraStreamRef.current
    if (!ultraStream || levelCount === 0) return
    if (reducedMotion) return

    const styles = getComputedStyle(ultraStream)
    const duration = cssDurationInMilliseconds(
      styles.getPropertyValue("--nessa-motion-duration-ambient"),
      3200,
    )
    const animation = ultraStream.animate(
      [
        { transform: "translateX(0%)" },
        { transform: "translateX(-50%)" },
      ],
      {
        duration,
        easing: "linear",
        iterations: Infinity,
      },
    )
    animation.playbackRate =
      streamSpeedMultiplierRef.current /
      (0.95 - streamEnergyRef.current * 0.68)
    ultraStreamAnimationRef.current = animation
    return () => {
      ultraStreamAnimationRef.current = null
      animation.cancel()
    }
  }, [levelCount, reducedMotion])

  React.useEffect(() => {
    const animation = ultraStreamAnimationRef.current
    if (!animation) return
    animation.playbackRate =
      streamSpeedMultiplier / (0.95 - streamEnergy * 0.68)
  }, [streamEnergy, streamSpeedMultiplier])

  return (
    <span
      ref={surfaceRef}
      data-slot="model-thinking-slider-liquid"
      aria-hidden="true"
      className={cn(
        "absolute inset-0 isolate overflow-hidden bg-(--nessa-thinking-fill-base)",
        thinkingFillGradientClass,
      )}
      style={{ "--model-thinking-fill-angle": dir === "rtl" ? "270deg" : "90deg" } as React.CSSProperties}
    >
      <span
        ref={currentRef}
        data-slot="model-thinking-slider-current"
        className="absolute aspect-square rounded-full bg-[var(--nessa-thinking-fill-current)] opacity-25 [filter:blur(var(--model-thinking-slider-current-blur))]"
        style={{
          insetBlock:
            "calc(var(--model-thinking-slider-current-inset) * -1)",
          insetInlineStart:
            "calc(var(--model-thinking-slider-current-offset) * -1)",
        }}
      />
      <span
        ref={flareRef}
        data-slot="model-thinking-slider-flare"
        className="absolute top-1/2 size-[var(--model-thinking-slider-flare-size)] rounded-full opacity-0 bg-(--nessa-thinking-fill-highlight) [filter:blur(var(--model-thinking-slider-flare-blur))]"
        style={{
          insetInlineEnd: 0,
        }}
      />
      <span
        ref={ultraStreamRef}
        dir="ltr"
        data-slot="model-thinking-slider-ultra-stream"
        data-energy={streamEnergy.toFixed(2)}
        className="absolute inset-y-0 left-0 flex w-[200%] will-change-transform [filter:saturate(var(--model-thinking-stream-saturate))_brightness(var(--model-thinking-stream-brightness))]"
        style={{
          "--model-thinking-stream-saturate": `${1 + streamEnergy * 0.7}`,
          "--model-thinking-stream-brightness": `${1 + streamEnergy * 0.22}`,
          opacity: streamOpacity,
        } as React.CSSProperties}
      >
        <span
          data-slot="model-thinking-slider-ultra-stream-period"
          className={cn("h-full w-1/2 shrink-0", streamSheenTextureClass)}
        />
        <span
          data-slot="model-thinking-slider-ultra-stream-period"
          className={cn("h-full w-1/2 shrink-0", streamSheenTextureClass)}
        />
      </span>
      <span className="absolute inset-0 [box-shadow:inset_0_1px_color-mix(in_oklab,var(--foreground)_13%,transparent),inset_0_-1px_color-mix(in_oklab,var(--background)_16%,transparent)]" />
    </span>
  )
}

/** Renders the ordered, continuously draggable thinking-level slider. */
function ModelThinkingSlider({
  ref,
  levels,
  value,
  onValueChange,
  onCheckpoint,
  dir,
  size = "sm",
  streamSpeedMultiplier = 1,
  sliderLabel = "Thinking level",
  getValueText,
  unavailableText = "Unavailable",
  className,
}: ModelThinkingSliderProps) {
  const [dragging, setDragging] = React.useState(false)
  const [dragPosition, setDragPosition] = React.useState<number | null>(null)
  const draggingRef = React.useRef(false)
  const dragPositionRef = React.useRef<number | null>(null)
  const activePointerIdRef = React.useRef<number | null>(null)
  const activePointerTargetRef = React.useRef<Element | null>(null)
  const dragCatalogIdentityRef = React.useRef<string | null>(null)
  const selectedIndex = resolveLevelIndex(levels, value)
  const previewIndexRef = React.useRef(selectedIndex)
  const singleLevel = levels.length === 1
  const semanticMax = Math.max(0, levels.length - 1)
  const normalizedStreamSpeedMultiplier =
    normalizeStreamSpeedMultiplier(streamSpeedMultiplier)
  const catalogIdentity = JSON.stringify(
    levels.map(({ value: levelValue, label, description, accent }) => [
      levelValue,
      label,
      description,
      accent,
    ]),
  )
  const effectiveDir = Direction.useDirection(dir)
  const sliderPosition = singleLevel ? 1 : selectedIndex
  const rootPosition =
    dragPosition === null
      ? sliderPosition
      : Math.max(0, Math.min(semanticMax, dragPosition))
  const visualPosition = singleLevel ? 0 : rootPosition
  const nearestIndex = Math.round(visualPosition)
  const atDetent = Math.abs(visualPosition - nearestIndex) < 0.001
  const visualLevel = levels[nearestIndex]
  const lowerLevel = levels[Math.floor(visualPosition)]
  const upperLevel = levels[Math.ceil(visualPosition)]
  const visualValueText = getValueText
    ? getValueText(lowerLevel, upperLevel)
    : atDetent
      ? (visualLevel?.label ?? unavailableText)
      : `${lowerLevel?.label ?? unavailableText} to ${upperLevel?.label ?? unavailableText}`
  const selectIndex = React.useCallback(
    (index: number) => {
      const next = levels[index]
      if (next) {
        onCheckpoint?.(next, index)
        onValueChange(next.value)
      }
    },
    [levels, onCheckpoint, onValueChange],
  )
  const resetDragging = React.useCallback(() => {
    const pointerId = activePointerIdRef.current
    const pointerTarget = activePointerTargetRef.current
    draggingRef.current = false
    dragPositionRef.current = null
    activePointerIdRef.current = null
    activePointerTargetRef.current = null
    dragCatalogIdentityRef.current = null
    if (
      pointerId !== null &&
      pointerTarget?.hasPointerCapture(pointerId)
    ) {
      pointerTarget.releasePointerCapture(pointerId)
    }
    setDragPosition(null)
    setDragging(false)
  }, [])
  const finishDragging = React.useCallback(
    (position = dragPositionRef.current) => {
      if (!draggingRef.current) return
      draggingRef.current = false
      if (position !== null) {
        const committedIndex = Math.round(position)
        if (committedIndex !== previewIndexRef.current) {
          selectIndex(committedIndex)
        }
        previewIndexRef.current = committedIndex
      }
      resetDragging()
    },
    [resetDragging, selectIndex],
  )
  React.useLayoutEffect(() => {
    if (
      draggingRef.current &&
      dragCatalogIdentityRef.current !== catalogIdentity
    ) {
      resetDragging()
    }
  }, [catalogIdentity, resetDragging])
  React.useEffect(() => {
    const stopDragging = (event: PointerEvent) => {
      if (event.pointerId === activePointerIdRef.current) finishDragging()
    }
    const stopDraggingOnBlur = () => {
      finishDragging()
    }
    window.addEventListener("pointerup", stopDragging)
    window.addEventListener("pointercancel", stopDragging)
    window.addEventListener("blur", stopDraggingOnBlur)
    return () => {
      window.removeEventListener("pointerup", stopDragging)
      window.removeEventListener("pointercancel", stopDragging)
      window.removeEventListener("blur", stopDraggingOnBlur)
    }
  }, [finishDragging])

  const beginDragging = (event: React.PointerEvent<HTMLElement>) => {
    if (
      levels.length <= 1 ||
      draggingRef.current ||
      event.isPrimary === false ||
      event.button !== 0
    ) {
      event.preventDefault()
      return
    }
    draggingRef.current = true
    dragPositionRef.current = sliderPosition
    activePointerIdRef.current = event.pointerId
    activePointerTargetRef.current = event.target as Element
    dragCatalogIdentityRef.current = catalogIdentity
    previewIndexRef.current = selectedIndex
    setDragPosition(sliderPosition)
    setDragging(true)
  }

  const updateDragPosition = (position: number) => {
    if (!draggingRef.current) {
      const nextIndex = Math.round(position)
      if (nextIndex !== selectedIndex) selectIndex(nextIndex)
      return
    }
    const bounded = Math.max(0, Math.min(levels.length - 1, position))
    const nearest = Math.round(bounded)
    const softPosition =
      Math.abs(bounded - nearest) <= 0.14 ? nearest : bounded
    if (nearest !== previewIndexRef.current) {
      previewIndexRef.current = nearest
      selectIndex(nearest)
    }
    dragPositionRef.current = softPosition
    setDragPosition(softPosition)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const rtl = effectiveDir === "rtl"
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? levels.length - 1
          : event.key === "ArrowUp" ||
              event.key === "PageUp" ||
              (event.key === "ArrowRight" && !rtl) ||
              (event.key === "ArrowLeft" && rtl)
            ? Math.min(levels.length - 1, selectedIndex + 1)
            : event.key === "ArrowDown" ||
                event.key === "PageDown" ||
                (event.key === "ArrowLeft" && !rtl) ||
                (event.key === "ArrowRight" && rtl)
              ? Math.max(0, selectedIndex - 1)
              : null
    if (nextIndex === null || nextIndex === selectedIndex) return
    event.preventDefault()
    selectIndex(nextIndex)
  }

  return (
    <Slider.Root
      ref={ref}
      data-slot="model-thinking-slider"
      data-model-capability-control="thinking-slider"
      data-size={size}
      dir={effectiveDir}
      value={[rootPosition]}
      min={0}
      max={Math.max(1, levels.length - 1)}
      step={0.01}
      disabled={levels.length <= 1}
      onPointerDown={beginDragging}
      onValueChange={([position]) => updateDragPosition(position ?? 0)}
      onValueCommit={([position]) => finishDragging(position ?? 0)}
      style={modelThinkingSliderSizeStyles[size]}
      className={cn(
        "relative flex h-[var(--model-thinking-slider-size)] w-full touch-none select-none items-center",
        className,
      )}
    >
      <Slider.Track
        data-slot="model-thinking-slider-track"
        className="relative h-[var(--model-thinking-slider-size)] w-full grow overflow-hidden rounded-[var(--model-thinking-slider-radius)] border border-border bg-muted"
      >
        <Slider.Range
          data-slot="model-thinking-slider-range"
          className="absolute h-full overflow-hidden bg-foreground/15 text-foreground"
        >
          <ModelThinkingSliderFill
            dir={effectiveDir}
            levelIndex={selectedIndex}
            levelPosition={visualPosition}
            levelCount={levels.length}
            isUltra={visualLevel?.accent === "ultra"}
            streamSpeedMultiplier={normalizedStreamSpeedMultiplier}
          />
        </Slider.Range>
      </Slider.Track>
      <Slider.Thumb
        aria-label={sliderLabel}
        aria-disabled={levels.length <= 1}
        aria-valuemin={0}
        aria-valuemax={semanticMax}
        aria-valuenow={visualPosition}
        aria-valuetext={visualValueText}
        data-dragging={dragging}
        data-active-pointer-id={
          dragging ? activePointerIdRef.current ?? undefined : undefined
        }
        data-detent={atDetent}
        data-position={visualPosition.toFixed(2)}
        onKeyDown={handleKeyDown}
        onLostPointerCapture={(event) => {
          if (event.pointerId === activePointerIdRef.current) finishDragging()
        }}
        className="block size-[var(--model-thinking-slider-size)] cursor-grab rounded-full border border-border bg-foreground shadow-md outline-none transition-transform [transition-duration:var(--nessa-motion-duration-fast)] [transition-timing-function:var(--nessa-motion-easing-standard)] focus-visible:[outline-style:solid] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring data-[disabled]:pointer-events-none data-[disabled]:cursor-default data-[dragging=true]:cursor-grabbing data-[dragging=true]:scale-[var(--model-thinking-slider-drag-scale)] motion-reduce:transition-none"
      />
    </Slider.Root>
  )
}

/** Composes a thinking-level trigger, popover, optional Fast toggle, and slider. */
function ModelThinkingControl({
  ref,
  levels,
  icon,
  dir,
  value: valueProp,
  defaultValue,
  onValueChange,
  onCheckpoint,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  disabled = false,
  className,
  contentClassName,
  portalContainer,
  side = "top",
  align = "end",
  sliderSize = "sm",
  triggerLabel,
  contentLabel = "Choose thinking level",
  sliderLabel = "Thinking level",
  sliderUnavailableText = "Unavailable",
  getSliderValueText,
  fastMode,
}: ModelThinkingControlProps) {
  const effectiveDir = Direction.useDirection(dir)
  const [uncontrolledValue, setUncontrolledValue] = React.useState(
    defaultValue ?? levels[0]?.value,
  )
  const value = valueProp ?? uncontrolledValue
  const selectedIndex = resolveLevelIndex(levels, value)
  const selected = levels[selectedIndex]
  const unavailable = disabled || levels.length === 0
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(
    defaultOpen && !unavailable,
  )
  const requestedOpen = openProp ?? uncontrolledOpen
  const effectiveOpen = !unavailable && requestedOpen
  const suppressedOpenNotifiedRef = React.useRef(false)

  React.useEffect(() => {
    if (requestedOpen && unavailable) {
      if (openProp === undefined) setUncontrolledOpen(false)
      if (!suppressedOpenNotifiedRef.current) {
        suppressedOpenNotifiedRef.current = true
        onOpenChange?.(false)
      }
      return
    }
    suppressedOpenNotifiedRef.current = false
  }, [onOpenChange, openProp, requestedOpen, unavailable])

  const setOpen = React.useCallback(
    (nextOpen: boolean) => {
      if (openProp === undefined) setUncontrolledOpen(nextOpen)
      onOpenChange?.(nextOpen)
    },
    [onOpenChange, openProp],
  )

  const selectIndex = (index: number) => {
    const next = levels[index]
    if (!next) return
    if (valueProp === undefined) setUncontrolledValue(next.value)
    onValueChange?.(next.value)
  }

  return (
    <Popover.Root
      open={effectiveOpen}
      onOpenChange={setOpen}
    >
      <Popover.Trigger asChild>
        <button
          ref={ref}
          type="button"
          data-slot="model-thinking-trigger"
          data-model-capability-control="thinking"
          aria-label={triggerLabel ?? (
            selected
              ? `Thinking level: ${selected.label}`
              : "Thinking levels unavailable"
          )}
          disabled={unavailable}
          className={cn(
            "inline-flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:[outline-style:solid] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-45",
            className,
          )}
        >
          {icon ?? <ModelThinkingIcon aria-hidden="true" />}
        </button>
      </Popover.Trigger>
      {!unavailable ? <Popover.Portal container={portalContainer}>
        <Popover.Content
          data-slot="model-thinking-content"
          data-model-capability-control="thinking-content"
          aria-label={contentLabel}
          dir={effectiveDir}
          side={side}
          align={align}
          sideOffset={8}
          collisionPadding={12}
          className={cn(
            "relative z-50 w-[min(17rem,calc(100vw-1.5rem))] rounded-xl border border-border bg-popover p-3 font-sans text-popover-foreground shadow-xl outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            contentClassName,
          )}
        >
          <span
            data-slot="model-thinking-ultra-shader"
            data-active={selected?.accent === "ultra"}
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 transition-[opacity,filter] [transition-duration:var(--nessa-motion-duration-normal)] [transition-timing-function:var(--nessa-motion-easing-emphasized)] data-[active=true]:opacity-100 motion-reduce:transition-none [background:radial-gradient(circle_at_78%_12%,color-mix(in_oklab,var(--nessa-thinking-fill-current)_13%,transparent),transparent_62%)] [box-shadow:0_0_1rem_color-mix(in_oklab,var(--nessa-thinking-fill-current)_10%,transparent)]"
          />
          <div className="relative z-10 flex min-h-8 items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-1 nessa-text-4 font-medium">
              <span data-slot="model-thinking-level-label" className="truncate">
                {selected?.label}
              </span>
              <ChevronRight
                aria-hidden="true"
                className={cn(
                  "size-4 shrink-0 text-muted-foreground",
                  effectiveDir === "rtl" && "rotate-180",
                )}
              />
            </div>
            {fastMode ? (
              <ModelFastMode
                pressed={fastMode.pressed}
                onPressedChange={fastMode.onPressedChange}
                icon={fastMode.icon}
                disabled={fastMode.disabled}
              />
            ) : null}
          </div>
          <ModelThinkingSlider
            dir={effectiveDir}
            levels={levels}
            value={selected?.value ?? ""}
            size={sliderSize}
            streamSpeedMultiplier={
              fastMode?.pressed
                ? (fastMode.streamSpeedMultiplier ?? 1.6)
                : 1
            }
            sliderLabel={sliderLabel}
            unavailableText={sliderUnavailableText}
            getValueText={getSliderValueText}
            onCheckpoint={onCheckpoint}
            onValueChange={(nextValue) => {
              const index = levels.findIndex((level) => level.value === nextValue)
              if (index >= 0) selectIndex(index)
            }}
            className="relative z-10 mt-3"
          />
        </Popover.Content>
      </Popover.Portal> : null}
    </Popover.Root>
  )
}

export {
  ModelFastMode,
  ModelFastModeIcon,
  ModelThinkingControl,
  ModelThinkingIcon,
  ModelThinkingSlider,
}
