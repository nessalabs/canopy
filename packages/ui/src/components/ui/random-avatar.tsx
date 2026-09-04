import * as React from "react"

import { cn } from "@/lib/utils"

const reducedMotionQuery = "(prefers-reduced-motion: reduce)"

function subscribeToReducedMotion(callback: () => void) {
  const query = window.matchMedia(reducedMotionQuery)
  query.addEventListener("change", callback)
  return () => query.removeEventListener("change", callback)
}

/**
 * `useLayoutEffect` on the client, `useEffect` on the server. Entrance motion
 * has to attach before paint; warning about it during SSR does not help.
 */
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

/** Returns the live, server-safe reduced-motion preference. */
function useReducedMotion() {
  return React.useSyncExternalStore(
    subscribeToReducedMotion,
    () => window.matchMedia(reducedMotionQuery).matches,
    () => false,
  )
}

/**
 * Motion tokens live on a Nessa scope, not on the avatar, so every instance in
 * a list would otherwise force its own style recalculation to read the same
 * two values. The measurement is cached against the scope that owns it — not
 * the document — so an avatar inside a scope that overrides the ambient
 * duration is not served the first-mounted avatar's timing.
 */
const motionCache = new WeakMap<Element, { slow: number; ambient: number }>()

const MOTION_SCOPE_SELECTOR =
  "[data-nessa-root],[data-nessa-theme],[data-nessa-scale]"

function readMotionDurations(node: Element) {
  const root =
    node.closest(MOTION_SCOPE_SELECTOR) ?? node.ownerDocument.documentElement
  const cached = motionCache.get(root)
  if (cached) return cached
  const style = getComputedStyle(root)
  const measured = {
    slow: cssDurationInMilliseconds(
      style.getPropertyValue("--nessa-motion-duration-slow"),
      300,
    ),
    ambient: cssDurationInMilliseconds(
      style.getPropertyValue("--nessa-motion-duration-ambient"),
      3200,
    ),
  }
  // Zeroes are not cached. Under `prefers-reduced-motion` the tokens collapse
  // to 0ms, and caching that would outlive the preference: turning reduced
  // motion back off would leave every avatar in the scope permanently still,
  // because the cache is never invalidated.
  if (measured.slow > 0 && measured.ambient > 0) motionCache.set(root, measured)
  return measured
}

/** Parses a CSS duration token value into milliseconds. */
function cssDurationInMilliseconds(value: string, fallback: number) {
  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return fallback
  return value.trim().endsWith("ms") ? parsed : parsed * 1000
}

/**
 * The default hue wheel: eight well-separated hues chosen to stay pleasant as
 * dilute pigment, where the olive and mustard end of the wheel turns muddy.
 */
const randomAvatarHues = Object.freeze([
  20, 55, 140, 175, 210, 250, 292, 330,
] as const)

/**
 * A colour range in OKLCH: the lightness and chroma bands pigment is mixed
 * from. Both are `[min, max]` pairs — give the same number twice to pin a
 * value exactly. Lightness runs 0–1, chroma 0 (grey) to about 0.37.
 */
export interface RandomAvatarToneRange {
  lightness: readonly [number, number]
  chroma: readonly [number, number]
}

/**
 * The named tone presets, from a thin wash to saturated pigment. `soft` is the
 * default: enough colour to read at list size, still quiet beside text.
 */
const randomAvatarTones = Object.freeze({
  pastel: { lightness: [0.86, 0.91], chroma: [0.055, 0.085] },
  soft: { lightness: [0.76, 0.82], chroma: [0.09, 0.13] },
  vivid: { lightness: [0.63, 0.7], chroma: [0.16, 0.21] },
  deep: { lightness: [0.45, 0.53], chroma: [0.11, 0.16] },
} as const satisfies Record<string, RandomAvatarToneRange>)

/**
 * How dilute the paint is: a preset name, or a `RandomAvatarToneRange` of your
 * own. The preset names are derived from the catalog, so the two cannot drift.
 */
export type RandomAvatarTone =
  | keyof typeof randomAvatarTones
  | RandomAvatarToneRange

/**
 * What the paint is laid on. `paper` is a light, faintly tinted ground for
 * light surfaces; `ink` is a dark ground where the same pigment glows instead
 * of soaking in — the passes lighten rather than multiply, so a painting keeps
 * its structure on a dark sidebar instead of reading as a bright coin.
 */
export type RandomAvatarGround = "paper" | "ink"

/** FNV-1a over the seed's code units, so equal strings start equal chains. */
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** A mulberry32 stream: cheap, stable across runtimes, and seedable. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Coerces a numeric prop to something safe to paint or animate with. `NaN`
 * survives `Math.max`, and a `NaN` duration makes `Element.animate` throw, so
 * every host-supplied number passes through here first.
 */
function finite(value: number, fallback: number, floor = 0): number {
  return Number.isFinite(value) ? Math.max(floor, value) : fallback
}

/** Draws a value from a `[min, max]` band, tolerating a reversed pair. */
function sample(random: () => number, band: readonly [number, number]): number {
  const low = finite(band[0], 0)
  const high = finite(band[1], low)
  return Math.min(low, high) + random() * Math.abs(high - low)
}

/** The default wash band, hoisted so the default never changes identity. */
const DEFAULT_WASHES = Object.freeze([2, 5] as const)

/** The canvas is a 100×100 square whose inscribed circle is the avatar. */
const CENTER = 50
const RADIUS = 50

/**
 * Rounds a coordinate to a thousandth of the canvas before it can reach the
 * DOM. `Math.sin` and `Math.cos` are not required to return the same bits on
 * every implementation, and do not: a coordinate painted by Node during SSR
 * and the same coordinate recomputed by the browser can differ in the last
 * place, which React reports as a hydration mismatch on every avatar rendered
 * on the server. Quantising also stops that difference being amplified — the
 * rotation in `blobPath` subtracts two nearly equal terms, so a discrepancy
 * of 1e-17 can surface in the third decimal of the result.
 *
 * A thousandth of a 100-unit canvas is a hundredth of a pixel on a 40px
 * avatar, so nothing about the painting changes; the path strings simply get
 * shorter. It is not a proof of agreement — two engines could still land
 * either side of a rounding boundary — but it removes every difference large
 * enough to be reachable in practice.
 */
function quantise(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** A point on the circle of `distance` around the centre, in degrees. */
function polar(angle: number, distance: number): { x: number; y: number } {
  const radians = (angle * Math.PI) / 180
  return {
    x: quantise(CENTER + Math.cos(radians) * distance),
    y: quantise(CENTER + Math.sin(radians) * distance),
  }
}

/**
 * A closed organic outline: points scattered around an ellipse at uneven radii,
 * joined by quadratic curves through their midpoints. The midpoint join is what
 * keeps the outline smooth — interpolating the points directly leaves visible
 * corners wherever two long spans meet.
 */
function blobPath(
  random: () => number,
  center: { x: number; y: number },
  radius: number,
  wobble: number,
): string {
  const count = 7 + Math.floor(random() * 4)
  const squash = 0.72 + random() * 0.45
  const tilt = random() * Math.PI * 2
  const points = Array.from({ length: count }, (_unused, index) => {
    const angle = (index / count) * Math.PI * 2
    const reach = radius * (1 - wobble / 2 + random() * wobble)
    const x = Math.cos(angle) * reach
    const y = Math.sin(angle) * reach * squash
    return {
      x: quantise(center.x + x * Math.cos(tilt) - y * Math.sin(tilt)),
      y: quantise(center.y + x * Math.sin(tilt) + y * Math.cos(tilt)),
    }
  })

  const midpoint = (from: { x: number; y: number }, to: { x: number; y: number }) => ({
    x: quantise((from.x + to.x) / 2),
    y: quantise((from.y + to.y) / 2),
  })

  const first = midpoint(points[count - 1]!, points[0]!)
  let path = `M ${first.x} ${first.y}`
  for (let index = 0; index < count; index += 1) {
    const control = points[index]!
    const next = midpoint(control, points[(index + 1) % count]!)
    path += ` Q ${control.x} ${control.y} ${next.x} ${next.y}`
  }
  return `${path} Z`
}

/** One pass of pigment: where it was laid, in what colour, how strongly. */
interface Wash {
  path: string
  /** Where the pool was dropped; motion pivots here, not on the disc. */
  origin: { x: number; y: number }
  color: string
  opacity: number
  /** Pigment settles at the edge of a drying pool; this is that rim. */
  rimOpacity: number
}

/**
 * Lays down the washes for one avatar. Every pass is a translucent pool of the
 * same family of hues, dropped off-centre and allowed to overlap: because the
 * pools multiply, each overlap deepens like real pigment rather than covering
 * what is underneath.
 */
function paint(
  random: () => number,
  hue: number,
  hueSpread: number,
  lightness: number,
  chroma: number,
  count: number,
  ground: RandomAvatarGround,
  /**
   * Where this run of passes belongs. A solo painting floods its first pool
   * past the edge of the paper and works inward; a grouped agent is given a
   * corner of the paper to keep to, so agents sit beside each other instead
   * of each one flooding over the last.
   */
  anchor: { x: number; y: number } | null = null,
): Wash[] {
  return Array.from({ length: count }, (_unused, index) => {
    // The first pool is the broad one; later passes are smaller and land
    // further out, the way a brush is reloaded and touched in beside a wash.
    const spread = index === 0 ? 8 : 12 + random() * 18
    const drift = polar(random() * 360, anchor ? 6 : spread)
    const center = anchor
      ? {
          x: quantise(anchor.x + drift.x - CENTER),
          y: quantise(anchor.y + drift.y - CENTER),
        }
      : drift
    const radius = anchor
      ? (index === 0 ? 34 : 22 + random() * 10) * (0.9 + random() * 0.3)
      : (index === 0 ? 52 : 24 + random() * 18) * (0.9 + random() * 0.3)
    // Every third pass or so is a different pigment touched into the wet
    // wash rather than more of the same one, which is where the two-colour
    // bleeds come from.
    const accent = index > 0 && random() < 0.34
    const washHue =
      hue +
      (random() - 0.5) * 2 * hueSpread +
      (accent ? (random() < 0.5 ? -1 : 1) * (38 + random() * 46) : 0)
    // On ink the passes screen together, so each one has to start darker or
    // the stack blows out to white where three pools cross.
    const washLightness =
      ground === "ink"
        ? Math.max(0.22, lightness - 0.28 + (random() - 0.5) * 0.14)
        : Math.min(0.97, lightness + (random() - 0.45) * 0.16)
    return {
      path: blobPath(random, center, radius, 0.28 + random() * 0.36),
      origin: center,
      color: `oklch(${washLightness} ${chroma * (0.75 + random() * 0.5)} ${washHue})`,
      opacity: 0.5 + random() * 0.32,
      rimOpacity: 0.26 + random() * 0.3,
    }
  })
}

interface PaintingOptions {
  agents: readonly string[]
  hues: readonly number[]
  tone: RandomAvatarTone
  washes: readonly [number, number]
  hueSpread: number
  ground: RandomAvatarGround
}

/**
 * Derives an entire painting from one seeded stream: which agents share the
 * paper, the pigment they are mixed from, every pool, and the paper's own
 * texture. Kept in one function because the values are drawn in order — moving
 * or skipping a draw repaints everything after it.
 */
function buildPainting({
  agents,
  hues,
  tone,
  washes,
  hueSpread,
  ground,
}: PaintingOptions) {
  const shared = agents.length > 1
  const identity = agents.join("\u0000")
  const random = createRandom(hashSeed(identity))

  const wheel = hues.length > 0 ? hues : randomAvatarHues
  const range = typeof tone === "string" ? randomAvatarTones[tone] : tone
  const lightness = sample(random, range.lightness)
  const chroma = sample(random, range.chroma)
  const baseHue = finite(wheel[Math.floor(random() * wheel.length)] ?? 0, 0)

  const pools = agents.flatMap((agent, index) => {
    // Each agent's own stream picks its hue and its own passes; where it
    // lands, and the tone it is mixed at, belong to the group.
    const agentRandom = createRandom(hashSeed(agent))
    const agentHue = finite(
      wheel[Math.floor(agentRandom() * wheel.length)] ?? 0,
      0,
    )
    // A group shares the wash band rather than ignoring it: each agent draws
    // its own share, so `washes` still describes how much paint ends up on
    // this one piece of paper — give or take the one-pool floor every agent
    // is guaranteed.
    const band = shared
      ? ([
          Math.max(1, finite(washes[0], 2) / agents.length),
          Math.max(1, finite(washes[1], 5) / agents.length),
        ] as const)
      : washes
    const count = Math.max(
      1,
      Math.round(sample(shared ? agentRandom : random, band)),
    )
    // Agents are spaced around the paper and pulled toward the centre, so a
    // group reads as one painting with several pigments in it rather than as
    // a ring of separate blots.
    const anchor = shared
      ? polar(
          (index * 360) / agents.length + agentRandom() * 40,
          14 + agentRandom() * 10,
        )
      : null
    return paint(
      shared ? agentRandom : random,
      shared ? agentHue : baseHue,
      finite(hueSpread, 34),
      lightness,
      chroma,
      count,
      ground,
      anchor,
    ).map((pool) => ({ ...pool, agent: index }))
  })

  return {
    agents,
    shared,
    pools,
    baseHue,
    lightness,
    chroma,
    // Paper carries the faintest memory of the pigment, so the white of the
    // page never reads as a hole punched in a coloured list. Ink is the same
    // idea inverted: a dark ground the pigment can glow against.
    paper:
      ground === "ink"
        ? `oklch(0.2 ${chroma * 0.5} ${baseHue})`
        : `oklch(${Math.min(0.975, lightness + 0.09)} ${chroma * 0.4} ${baseHue})`,
    // Turbulence settings are seeded too: the grain of the paper is part of
    // the identity, not a constant texture stamped over every avatar.
    bleedFrequency: (0.008 + random() * 0.014).toFixed(4),
    baseBleedScale: 14 + random() * 12,
    paperTilt: random() * 360,
    sweepAngle: random() * 360,
    textureSeed: hashSeed(identity),
  }
}

export interface RandomAvatarProps extends React.ComponentProps<"div"> {
  /**
   * The identity the painting is derived from — a user id, an email, a room
   * name. The same seed always paints the same avatar. Pass several seeds to
   * paint a group of agents: each one contributes its own pigment to a single
   * shared painting, which is the group counterpart of a facepile. The list is
   * treated as a set — reordering or repeating entries paints the same
   * picture — but membership
   * is the identity, so adding or removing an agent repaints the group, not
   * just its own pigment. An empty array paints the empty seed, so a group
   * whose membership has not loaded yet still renders a painting.
   */
  seed: string | readonly string[]
  /**
   * Names the picture for assistive technology. Without it the painting stays
   * decorative, which is right when the label sits beside it.
   */
  name?: string
  /**
   * The hue wheel the seed picks from, in degrees (0–360). Narrow it to tint a
   * whole surface — one product area, one workspace — without losing per-seed
   * variety, or pass a single hue to pin every avatar to it. Defaults to
   * `randomAvatarHues`, eight hues chosen to stay pleasant as dilute pigment;
   * an empty array falls back to that default rather than painting grey.
   */
  hues?: readonly number[]
  /**
   * How far individual washes wander from the base hue, in degrees. `0` mixes
   * every pass from one pigment; the default `34` lets a wash drift the way a
   * second colour bleeds into a wet pool. Wide values turn polychrome.
   */
  hueSpread?: number
  /**
   * How dilute the paint is. Defaults to `"soft"`. Pass `"pastel"` for a
   * thinner wash, `"vivid"` or `"deep"` for heavier pigment, or a
   * `RandomAvatarToneRange` of your own.
   */
  tone?: RandomAvatarTone
  /**
   * How many passes of paint to lay down, as a `[min, max]` band the seed
   * draws from; defaults to `[2, 5]`. Fewer passes read as a single spill,
   * more build depth. With several seeds each agent draws its own share of the
   * band, so the whole painting stays near it — except that every agent is
   * guaranteed at least one pass, which a large group can push past `max`.
   */
  washes?: readonly [number, number]
  /**
   * What the paint is laid on. Defaults to `"paper"`; pass `"ink"` on dark
   * surfaces so the pigment glows on a dark ground instead of sitting in a
   * bright disc.
   */
  ground?: RandomAvatarGround
  /**
   * Multiplies the pace of the working cycle. `1` is the default breath
   * (~5s); `0.5` halves it to an almost imperceptible drift, `2` doubles it.
   * The cycle is derived from the ambient motion token, so this scales that
   * rather than replacing it.
   */
  speed?: number
  /**
   * How far pigment creeps at the edges — the wet bleed. `0` gives clean
   * shapes with no diffusion at all, `1` is the default wash, higher values
   * dissolve the pools into the paper.
   */
  bleed?: number
  /**
   * How far a wash expands while working. `1` is the default takeover, scaled
   * by how many washes the painting has — a dense painting floods completely,
   * a sparse one holds back, since a two-pool avatar has nothing to hand over
   * to and a full sweep there just reads as a colour change. Lower values keep
   * the pools nearer their resting size: `0.25` breathes rather than floods.
   */
  flood?: number
  /**
   * How much tooth the paper has — the fine noise pigment settles into. `1`
   * is the default absorption, `0` prints the paint onto a smooth surface,
   * higher values coarsen it toward rough stock.
   */
  grain?: number
  /**
   * Plays the painting on: pools bloom in one after another, the way paint
   * hits wet paper. Off by default — a list of avatars should not animate on
   * every render — and inert under `prefers-reduced-motion`.
   */
  animateOnMount?: boolean
  /**
   * Keeps the paint alive: a wash floods the paper and hands over to the next
   * for as long as it stays true, which is how an agent shows it is working.
   * Turning it off walks each wash back to where it rests rather than snapping
   * it home; the wet edge, which lives in a filter, returns to rest at once.
   * Under `prefers-reduced-motion` the painting simply stays still.
   *
   * It also sets `aria-busy`, which marks the avatar as mid-update so
   * assistive technology can defer reporting it — that is not an announcement.
   * Where "working" has to reach a screen reader, own that in the host: a live
   * region, or a status the avatar sits beside.
   */
  busy?: boolean
}

/**
 * A deterministic generative avatar painted rather than drawn: two to five
 * translucent pools of pigment, dropped off-centre on tinted paper, their
 * edges pulled apart by turbulence so they bleed and granulate the way a wet
 * wash does. The pools multiply where they overlap, so the darker passages are
 * real pigment build-up rather than a second colour. Nothing here is a fixed
 * picture — the seed decides the hue, the number of passes, where each pool
 * lands, and how far its edge wanders, so the same user always paints the same
 * abstract, on every client and every render, with no image to fetch or store.
 *
 * Colour is configured in independent halves: `hues` chooses the part of the
 * wheel, `hueSpread` how far a single painting wanders across it,
 * and `tone` how dilute the paint is. The paint itself is tuned by `bleed`
 * (how far pigment creeps) and `grain` (how much tooth the paper has), and
 * its motion by `speed` and `flood`.
 *
 * It sizes itself from the box — set `size-*` (or width and height) through
 * `className` and the painting follows. `children` render above the picture,
 * which is where a presence dot or status badge belongs.
 *
 * Each avatar carries `data-figure`, a short description of what was painted
 * (`"4w@210"` — four washes, base hue 210; `"5w@140x3"` for a group of three).
 * It is a debugging and testing handle, not a stable format.
 */
function RandomAvatar({
  seed,
  name,
  hues = randomAvatarHues,
  hueSpread = 34,
  tone = "soft",
  washes = DEFAULT_WASHES,
  ground = "paper",
  speed = 1,
  bleed = 1,
  flood = 1,
  grain = 1,
  animateOnMount = false,
  busy = false,
  className,
  children,
  ...props
}: RandomAvatarProps) {
  const label = name === undefined || name === "" ? undefined : name
  const instanceId = React.useId()
  const paperId = `${instanceId}-paper`
  const bleedId = `${instanceId}-bleed`
  const grainId = `${instanceId}-grain`
  const clipId = `${instanceId}-clip`
  // One seed paints alone; several paint together on shared paper, each agent
  // bringing its own pigment to the same pool of water. The list is sorted so
  // that membership, not the order an API happened to return it in, decides
  // the painting; an empty list still has to paint something, so it falls back
  // to the empty seed rather than rendering bare paper.
  const given = typeof seed === "string" ? [seed] : [...seed]
  const listed = [...new Set(given)].sort()
  const agentList = listed.length > 0 ? listed : [""]
  // A NUL-joined key would re-split a seed that itself contains one into two
  // phantom agents, so the list is passed through as a list and the string is
  // only ever a cache key.
  const identity = agentList.join("\u0000")

  // The whole painting is derived in one memo. Every value below comes off a
  // single ordered PRNG stream, so they cannot be split apart — and the
  // animations depend on the pools by identity, so recomputing them on an
  // unrelated re-render would tear down and restage every running wash.
  //
  // The memo is keyed on the *contents* of those props, not their references:
  // `hues`, `washes`, and a custom `tone` are almost always inline literals at
  // the call site, so a reference-keyed memo would miss on every render and
  // restage the washes exactly as often as no memo at all.
  const paintKey = [
    identity,
    hues.join(","),
    typeof tone === "string"
      ? tone
      : `${tone.lightness.join("-")}/${tone.chroma.join("-")}`,
    washes.join("-"),
    hueSpread,
    ground,
  ].join("\u0001")
  const painting = React.useMemo(
    () => buildPainting({ agents: agentList, hues, tone, washes, hueSpread, ground }),
    // Keyed on the serialised contents above: the inputs are values, not
    // identities, and `hues`/`washes`/`tone` are inline literals at almost
    // every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [paintKey],
  )
  const {
    agents,
    shared,
    pools,
    baseHue,
    lightness,
    chroma,
    paper,
    bleedFrequency,
    baseBleedScale,
    paperTilt,
    sweepAngle,
    textureSeed,
  } = painting
  const bleedScale = baseBleedScale * finite(bleed, 1)
  // At zero the filter has nothing left to do but blur, so it is dropped
  // entirely — `bleed={0}` means clean shapes, and a whole turbulence raster
  // per avatar is not worth paying for a softness the prop disclaims. The
  // group still has to isolate, or the pools would blend with the paper
  // individually instead of as one sheet of paint.
  const bleeding = finite(bleed, 1) > 0
  // Pools screen on ink and multiply on paper: the same passes have to build
  // toward the light on a dark ground and toward the dark on a light one.
  const blendModeClass = ground === "ink" ? "mix-blend-screen" : "mix-blend-multiply"

  const reducedMotion = useReducedMotion()
  const busyMotion = busy && !reducedMotion
  const poolsRef = React.useRef<SVGGElement>(null)
  const svgRef = React.useRef<SVGSVGElement>(null)
  const settleFrame = React.useRef<number | null>(null)
  const figure = `${pools.length}w@${Math.round(baseHue)}${shared ? `x${agents.length}` : ""}`

  // The measured cycle drives the SMIL edge animation too, so the wet edge
  // and the wash it belongs to stay on one clock even when a consumer
  // overrides the ambient duration token. It is measured on mount rather than
  // when work starts, so the filter never renders one cycle at the fallback
  // duration and then restarts when the real value arrives.
  const [ambientMs, setAmbientMs] = React.useState<number | null>(null)
  // In seconds: the token is measured in milliseconds for `Element.animate`,
  // and SMIL's `dur` is not. Emitting the raw figure made every cycle a
  // thousand times too long, which left the wet edge visibly inert.
  const workingCycleSeconds =
    ((ambientMs ?? 0) * 1.6) / finite(speed, 1, 0.05) / 1000
  useIsomorphicLayoutEffect(() => {
    const node = poolsRef.current
    if (!node) return
    setAmbientMs(readMotionDurations(node).ambient)
    // Re-measured when the motion preference changes: the tokens collapse to
    // zero under reduced motion, so a value taken while it was on must not
    // survive it being turned off.
  }, [reducedMotion])

  // Layout effect, not a passive one: the bloom must be attached before the
  // browser paints, or the first frame shows the finished painting and then
  // jumps back to the start.
  useIsomorphicLayoutEffect(() => {
    const node = poolsRef.current
    if (!node || reducedMotion || !animateOnMount) return
    const { slow } = readMotionDurations(node)
    if (slow <= 0) return
    // Pools bloom in sequence, each one landing while the last is still
    // spreading, the way a loaded brush is touched in beside a wet wash.
    const animations = Array.from(node.children, (child, index) =>
      (child as SVGGElement).animate(
        [
          { opacity: 0, scale: "0.82" },
          { opacity: 1, scale: "1" },
        ],
        {
          duration: slow * 1.6,
          delay: index * slow * 0.45,
          easing: "cubic-bezier(0.2, 0, 0, 1)",
          // Backwards, not both: the last keyframe is the resting state
          // anyway, and holding it would let a replayed entrance override the
          // `scale` of a flood already running underneath it.
          fill: "backwards",
        },
      ),
    )
    return () => animations.forEach((animation) => animation.cancel())
    // Deliberately not keyed on `busy`, `speed`, or `flood`: the entrance
    // belongs to the mount and to a repainted figure, and replaying it when
    // an agent starts working would blink the whole painting out.
  }, [animateOnMount, reducedMotion, painting])

  React.useEffect(() => {
    const node = poolsRef.current
    if (!node || reducedMotion || !busy) return

    // Waits for the measured value rather than staging once with a fallback
    // and again with the real figure — 40 avatars mounting at once would
    // otherwise create, cancel, and recreate every animation.
    const ambient = ambientMs ?? 0
    if (ambient <= 0) return
    // Only a run that is about to stage the washes itself cancels a pending
    // walk home. Cancelling above any of these guards would kill the settle on
    // the very transition it exists for: this effect re-runs when `busy` goes
    // false, and that run returns before reaching here.
    if (settleFrame.current !== null) {
      cancelAnimationFrame(settleFrame.current)
      settleFrame.current = null
    }
    const poolCount = node.children.length
    // Working reads as a tide: a wash runs in from one side, fills to where
    // it can reach, and recedes as the next arrives against it. Consecutive
    // pools take opposite headings, so the handover is a crossing rather than
    // a shared pulse.
    //
    // Nothing here touches opacity, and every cycle begins and ends at the
    // resting transform: the painting a viewer already knows must not pale or
    // shift colour the moment the agent starts working. Density stays put,
    // only the paint moves.
    //
    // A ~5s cycle whose rise is shorter than its fall. The longer fall (the
    // 4-in/6-out pattern breathing guides teach) is what keeps a faster cycle
    // from reading as impatient.
    const cycle = (ambient * 1.6) / finite(speed, 1, 0.05)
    // A two-pool painting has nothing to hand over to, so a full takeover
    // there reads as the avatar simply changing colour. Sparse paintings
    // flood less; dense ones get the whole sweep.
    const density = Math.min(1, 0.55 + 0.12 * poolCount)
    const reach = finite(flood, 1) * density
    const animations = Array.from(node.children, (child, index) => {
      const heading = sweepAngle + index * 180
      // A wash does not nudge — it takes the paper. At its crest the pool is
      // scaled past the edge of the disc and pulled toward the middle, so the
      // whole avatar is briefly that pigment, then it recedes and the next
      // colour floods in behind it.
      const origin = pools[index]?.origin ?? { x: CENTER, y: CENTER }
      const toward = {
        x: ((CENTER - origin.x) * 0.45 + polar(heading, 6).x - CENTER) * reach,
        y: ((CENTER - origin.y) * 0.45 + polar(heading, 6).y - CENTER) * reach,
      }
      return (child as SVGGElement).animate(
        [
          { translate: "0px 0px", scale: "1" },
          {
            translate: `${toward.x.toFixed(2)}px ${toward.y.toFixed(2)}px`,
            scale: `${(1 + 1.3 * reach).toFixed(3)}`,
            offset: 0.4,
          },
          { translate: "0px 0px", scale: "1" },
        ],
        {
          duration: cycle,
          // Evenly spaced turns: each wash floods while the last is draining
          // back, so the paper is always being taken over by something.
          // Positive delays, so every pool still starts from the resting
          // painting.
          delay: (index * cycle) / Math.max(1, poolCount),
          // Sinusoidal ease-in-out: no hard stop at either end, which is what
          // keeps a loop from reading as a pulse.
          easing: "cubic-bezier(0.37, 0, 0.63, 1)",
          iterations: Infinity,
        },
      )
    })
    // A working avatar that has scrolled away still costs a filter re-raster
    // every frame, and a long roster can hold dozens of them. Both clocks —
    // the pool animations and the SMIL edge inside the SVG — stop while the
    // avatar is off screen and pick up where they left off when it returns.
    const svg: SVGSVGElement | null = svgRef.current
    const setRunning = (running: boolean) => {
      animations.forEach((animation) =>
        running ? animation.play() : animation.pause(),
      )
      if (!svg || typeof svg.pauseAnimations !== "function") return
      if (running) svg.unpauseAnimations()
      else svg.pauseAnimations()
    }
    const observer =
      typeof IntersectionObserver === "undefined" || svg === null
        ? null
        : new IntersectionObserver(
            ([entry]) => setRunning(entry?.isIntersecting !== false),
            { rootMargin: "64px" },
          )
    if (svg !== null) observer?.observe(svg)

    return () => {
      observer?.disconnect()
      // An unmounting avatar has nothing to walk home: React detaches the DOM
      // before flushing passive effects, so a disconnected node means this
      // cleanup is a teardown rather than a restage. Returning here also skips
      // a forced style read per pool that would be thrown away, and leaves no
      // scheduled frame for anything else to have to release.
      if (!node.isConnected) {
        animations.forEach((animation) => animation.cancel())
        return
      }
      // Read live rather than from the closure: this cleanup runs *because*
      // the preference changed, so the captured value is the old one, and the
      // cached durations can still hold the pre-reduced-motion timing.
      if (window.matchMedia(reducedMotionQuery).matches) {
        animations.forEach((animation) => animation.cancel())
        return
      }
      // Stopping work mid-flood would snap a pool from its crest back to rest
      // in one frame, and finishing is the transition a viewer sees most, so
      // each wash is walked home from wherever it had got to. Where it had got
      // to has to be read before the animations are cancelled, and the walk
      // home deferred a frame: this cleanup also runs when the effect merely
      // restages (a changed seed, speed, or the measured clock arriving), and
      // in that case the incoming run cancels the walk before it starts.
      //
      // The transforms are copied into plain strings before anything is
      // cancelled, and every pool is read before any pool is cancelled.
      // `getComputedStyle` returns a live declaration, so reading a property
      // off it after `cancel()` yields the base value — `"none"` — and the
      // walk home becomes an animation from rest to rest: it plays, it counts,
      // and it moves nothing.
      const resting = Array.from(node.children, (child) => {
        const pool = child as SVGGElement
        const current = getComputedStyle(pool)
        return {
          pool,
          translate: String(current.translate),
          scale: String(current.scale),
        }
      })
      animations.forEach((animation) => animation.cancel())
      const settle = readMotionDurations(node).slow
      if (settle > 0) {
        settleFrame.current = requestAnimationFrame(() => {
          settleFrame.current = null
          for (const { pool, translate, scale } of resting) {
            if (!pool.isConnected) continue
            // A pool that never moved has nothing to walk back from.
            if (translate === "none" && scale === "none") continue
            pool.animate(
              [{ translate, scale }, { translate: "0px 0px", scale: "1" }],
              {
                duration: settle * 1.4,
                easing: "cubic-bezier(0.2, 0, 0, 1)",
                // The last keyframe is the resting transform, so holding it
                // changes nothing visually — but it keeps the animation
                // observable after it finishes, which is what lets a test
                // assert the walk home had somewhere to walk back from.
                fill: "both",
              },
            )
          }
        })
      }
      if (svg && typeof svg.unpauseAnimations === "function") {
        svg.unpauseAnimations()
      }
    }
    // `painting` is memoised, so this stages the washes once per figure —
    // not on every render, which would reset the stagger the handover depends
    // on and re-sync every avatar on screen.
  }, [busy, reducedMotion, painting, speed, flood, ambientMs])

  return (
    <div
      data-slot="random-avatar"
      data-figure={figure}
      data-busy={busy ? "" : undefined}
      aria-busy={busy || undefined}
      className={cn(
        "relative isolate size-8 shrink-0 select-none overflow-hidden rounded-full",
        className,
      )}
      {...props}
    >
      {/* The role and label sit on the picture, not on the wrapper: `img` is
          a leaf role, so labelling the wrapper would prune `children` — the
          presence dot or badge a host puts on top — out of the accessibility
          tree. An empty name is treated as no name rather than as an unnamed
          image. */}
      <svg
        ref={svgRef}
        viewBox="0 0 100 100"
        className="absolute inset-0 size-full"
        role={label === undefined ? undefined : "img"}
        aria-label={label}
        aria-hidden={label === undefined ? true : undefined}
        focusable="false"
      >
        <defs>
          <clipPath id={clipId}>
            <circle cx={CENTER} cy={CENTER} r={RADIUS} />
          </clipPath>
          {/* The wet edge: low-frequency noise displaces the pool outlines so
              they wander and feather, then a light blur takes the hard edge
              off what the displacement leaves behind.

              The region is pinned in user space rather than left relative to
              the pools' bounding box. A flooded pool's box is two to three
              times the disc, so a bbox-relative region rasterised turbulence
              far outside the clip — several times the pixels, and a different
              number of them per seed; the rest was always being thrown away.
              The margin covers the displacement at rest
              and most of its working swell; a wide `bleed` can still reach
              past it, which shows as paint pulling back from the rim rather
              than as a defect. sRGB interpolation skips a linear-light
              conversion at every primitive boundary and keeps engines closer
              to each other. */}
          <filter
            id={bleedId}
            filterUnits="userSpaceOnUse"
            x={-24}
            y={-24}
            width={148}
            height={148}
            colorInterpolationFilters="sRGB"
          >
            <feTurbulence
              type="fractalNoise"
              baseFrequency={bleedFrequency}
              numOctaves={4}
              seed={textureSeed % 1000}
              result="noise"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="noise"
              scale={bleedScale}
              xChannelSelector="R"
              yChannelSelector="G"
              result="bled"
            >
              {/* While the agent works, the displacement itself breathes, so
                  the wet edge creeps across the paper instead of the pools
                  sliding as rigid shapes. Rendered only when it should run:
                  there is no reduced-motion switch inside a filter.

                  When work stops this element unmounts and the displacement
                  returns to its resting value in one frame: the pools glide
                  home, the texture does not. Walking it home too would mean
                  knowing where it had got to, and a filter attribute cannot be
                  read once React has removed the element animating it — the
                  removal restores the base value synchronously, so a capture
                  from a cleanup reads the destination rather than the crest.
                  Sampling it every frame to know better would cost more than
                  the polish is worth. */}
              {busyMotion && bleeding && workingCycleSeconds > 0 ? (
                <animate
                  attributeName="scale"
                  values={`${bleedScale};${bleedScale * 2};${bleedScale}`}
                  keyTimes="0;0.4;1"
                  calcMode="spline"
                  keySplines="0.37 0 0.63 1;0.37 0 0.63 1"
                  dur={`${workingCycleSeconds.toFixed(2)}s`}
                  repeatCount="indefinite"
                />
              ) : null}
            </feDisplacementMap>
            {/* Four octaves of fractal noise already carry the fine detail a
                second turbulence pass was re-deriving, at the price of a whole
                extra raster; the blur below stands in for the feathering it
                contributed. */}
            <feGaussianBlur in="bled" stdDeviation={1.1} />
          </filter>
          {/* Paper tooth: high-frequency noise, multiplied back at low
              strength so pigment looks absorbed rather than printed. */}
          <filter
            id={grainId}
            filterUnits="userSpaceOnUse"
            x={0}
            y={0}
            width={100}
            height={100}
            colorInterpolationFilters="sRGB"
          >
            {/* Coarse on purpose. At the default size a 100-unit viewBox is
                32px, so one period of the 0.75 noise this started at was under
                half a device pixel, and 0.55 was no better: it aliased, and
                resolved differently per display density — the one part of the
                painting that was not deterministic. 0.3 clears a pixel at the
                default size, and
                coarser noise reads stronger, so the strength below is lower
                than the aliased version needed. */}
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.3"
              numOctaves={2}
              seed={(textureSeed >>> 3) % 1000}
            />
            <feColorMatrix type="saturate" values="0" />
          </filter>
          <linearGradient
            id={paperId}
            gradientUnits="userSpaceOnUse"
            x1={polar(paperTilt + 180, RADIUS).x}
            y1={polar(paperTilt + 180, RADIUS).y}
            x2={polar(paperTilt, RADIUS).x}
            y2={polar(paperTilt, RADIUS).y}
          >
            <stop offset="0%" stopColor={paper} />
            <stop
              offset="100%"
              stopColor={
                ground === "ink"
                  ? `oklch(0.14 ${chroma * 0.3} ${baseHue})`
                  : `oklch(${Math.min(0.985, lightness + 0.15)} ${chroma * 0.2} ${baseHue})`
              }
            />
          </linearGradient>
        </defs>
        <g clipPath={`url(#${clipId})`}>
          <circle
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            fill={`url(#${paperId})`}
          />
          {/* A filter isolates its subtree, so the pools blend with each other
              but not with the ground beneath them. The blend mode therefore
              sits on the filtered group as well: the washes mix among
              themselves inside it, and the finished sheet of paint mixes with
              the paper. Putting the paper inside the filter instead would let
              the displacement drag its edge into the disc — at a wide `bleed`,
              far enough to open a bare crescent. */}
          <g
            filter={bleeding ? `url(#${bleedId})` : undefined}
            className={cn(blendModeClass, "isolate")}
          >
            <g ref={poolsRef}>
              {pools.map((pool, index) => (
                <g
                  key={index}
                  className={blendModeClass}
                  style={{
                    transformOrigin: `${pool.origin.x}px ${pool.origin.y}px`,
                    // Without an explicit box the origin above resolves
                    // against the pool's own bounding box on engines that
                    // still default to `fill-box`, and the flood pivots from
                    // the wrong point.
                    transformBox: "view-box",
                  }}
                >
                  <path
                    d={pool.path}
                    fill={pool.color}
                    opacity={pool.opacity}
                  />
                  <path
                    d={pool.path}
                    fill="none"
                    stroke={pool.color}
                    strokeWidth={3}
                    opacity={pool.rimOpacity}
                  />
                </g>
              ))}
            </g>
          </g>
          {finite(grain, 1) > 0 ? (
            <rect
              x={0}
              y={0}
              width={100}
              height={100}
              filter={`url(#${grainId})`}
              opacity={(ground === "ink" ? 0.055 : 0.085) * finite(grain, 1)}
              className={blendModeClass}
            />
          ) : null}
        </g>
      </svg>
      {children}
    </div>
  )
}

export { RandomAvatar, randomAvatarHues, randomAvatarTones }
