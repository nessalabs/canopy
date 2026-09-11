import { RandomAvatar, type RandomAvatarGround } from '@/components/ui/random-avatar'
import { cn } from '@/lib/utils'

/** What the agent is doing right now, as the turn reducer tracks it. */
export type Activity = 'thinking' | 'working' | 'solving'

/**
 * The motions the avatar can perform. Several can play at once: `breathe`, `wobble` and
 * `spin` move the painting itself, `tide` is nessa's own flood inside it, and the rest are
 * layers of the same paint around it — every layer is a second `RandomAvatar` of the same
 * seed, so a halo or a ripple is always in the agent's own colours.
 */
export type AvatarMotion = 'breathe' | 'tide' | 'glow' | 'halo' | 'ripple' | 'wobble' | 'spin' | 'shimmer' | 'moon'

/** Every motion, with the one-line description the lab page shows beside it. */
export const AVATAR_MOTIONS: ReadonlyArray<{ motion: AvatarMotion; label: string; description: string }> = [
  { motion: 'breathe', label: 'Breathe', description: 'The whole painting swells and settles, a short rise and a longer fall.' },
  { motion: 'tide', label: 'Tide', description: "Nessa's own flood: each wash takes the paper in turn while the wet edge creeps." },
  { motion: 'glow', label: 'Glow', description: 'A blurred copy of the paint bleeds past the rim and soaks back in.' },
  { motion: 'halo', label: 'Halo', description: 'An arc of the same paint circles the rim, the way a spinner would.' },
  { motion: 'ripple', label: 'Ripple', description: 'Rings of paint peel off the edge and dissolve.' },
  { motion: 'wobble', label: 'Wobble', description: 'The disc rocks a few degrees either way.' },
  { motion: 'spin', label: 'Spin', description: 'The painting turns slowly on its axis.' },
  { motion: 'shimmer', label: 'Shimmer', description: 'A band of light sweeps across the paper and rests.' },
  { motion: 'moon', label: 'Moon', description: 'A drop of the same paint orbits the disc.' }
]

/** What each activity looks like by default; the lab page lets these be tried against every alternative. */
export const ACTIVITY_MOTIONS: Record<Activity, readonly AvatarMotion[]> = {
  thinking: ['breathe', 'glow'],
  working: ['tide', 'halo'],
  solving: ['tide', 'ripple']
}

/** One cycle of motion per activity, in milliseconds; solving is the most urgent and moves fastest. */
const ACTIVITY_CYCLE_MS: Record<Activity, number> = { thinking: 4200, working: 3200, solving: 2200 }

/** How fast nessa's tide runs per activity, relative to its default breath. */
const ACTIVITY_TIDE_SPEED: Record<Activity, number> = { thinking: 0.8, working: 1, solving: 1.6 }

const LABEL: Record<Activity, string> = { thinking: 'Thinking', working: 'Working', solving: 'Solving' }

export interface AgentAvatarProps {
  /** The identity the painting is derived from; the same seed as the transcript's other avatars. */
  seed: string
  /** Names the picture for assistive technology; the activity is appended while it runs. */
  name?: string
  /** What the agent is doing; `null` paints the avatar at rest. Picks the motions unless `motions` is given. */
  activity?: Activity | null
  /** Explicit motions, for trying combinations; empty leaves the painting still. */
  motions?: readonly AvatarMotion[]
  /** One cycle of the motion in milliseconds; defaults per activity. */
  cycleMs?: number
  /** Pace of nessa's tide, relative to its default; defaults per activity. */
  tideSpeed?: number
  ground?: RandomAvatarGround
  /** Size the box with `size-*`; every layer follows. */
  className?: string
}

/**
 * The agent's avatar, alive while the agent is: the same seeded painting the transcript shows
 * beside every answer, given motion keyed to what the agent is doing, the way Claude Code's
 * mark pulses through a long turn. At rest it is exactly the `RandomAvatar` the rest of the
 * transcript uses, so the identity never changes — only whether it moves. Every decorative
 * layer is hidden from assistive technology and is only mounted while its motion plays; under
 * `prefers-reduced-motion` the layers stay but nothing animates.
 */
export function AgentAvatar({ seed, name, activity = null, motions, cycleMs, tideSpeed, ground, className }: AgentAvatarProps): React.JSX.Element {
  const active = new Set<AvatarMotion>(motions ?? (activity ? ACTIVITY_MOTIONS[activity] : []))
  const cycle = cycleMs ?? (activity ? ACTIVITY_CYCLE_MS[activity] : 3200)
  const speed = tideSpeed ?? (activity ? ACTIVITY_TIDE_SPEED[activity] : 1)
  const label = name ? (activity ? `${name}, ${LABEL[activity].toLowerCase()}` : name) : undefined
  const copy = { seed, ground, bleed: 0, grain: 0, 'aria-hidden': true } as const

  return (
    <span
      data-slot="agent-avatar"
      data-activity={activity ?? undefined}
      data-motions={[...active].join(' ') || undefined}
      className={cn('relative inline-block size-8 shrink-0 @container', className)}
      style={{ '--avatar-cycle': `${cycle}ms` } as React.CSSProperties}
    >
      {active.has('glow') ? <RandomAvatar {...copy} className="agent-avatar-glow absolute inset-0 size-full" /> : null}
      {active.has('ripple')
        ? [0, 0.5].map((offset) => (
            <span key={offset} aria-hidden className="agent-avatar-ripple absolute inset-0 rounded-full" style={{ animationDelay: `calc(var(--avatar-cycle) * -${offset})` }}>
              <RandomAvatar {...copy} className="absolute inset-0 size-full" />
            </span>
          ))
        : null}
      {active.has('halo') ? (
        <span aria-hidden className="agent-avatar-halo absolute -inset-[14%] rounded-full">
          <RandomAvatar {...copy} className="absolute inset-0 size-full blur-[1.5cqi]" />
        </span>
      ) : null}
      {/* Scale and rotation live on separate boxes so breathing and turning compose without a
          combined animation rule for every pair. */}
      <span className={cn('absolute inset-0', active.has('breathe') && 'agent-avatar-breathe')}>
        <span className={cn('absolute inset-0', active.has('wobble') && 'agent-avatar-wobble', active.has('spin') && 'agent-avatar-spin')}>
          <RandomAvatar seed={seed} name={label} ground={ground} busy={active.has('tide')} speed={speed} className="size-full" />
        </span>
      </span>
      {active.has('shimmer') ? (
        <span aria-hidden className="absolute inset-0 overflow-hidden rounded-full mix-blend-soft-light">
          <span className="agent-avatar-shimmer absolute -inset-y-1/4 left-0 w-[40%] -skew-x-12 bg-linear-to-r from-transparent via-white/80 to-transparent" />
        </span>
      ) : null}
      {active.has('moon') ? (
        <span aria-hidden className="agent-avatar-moon absolute inset-0">
          <RandomAvatar {...copy} className="absolute left-1/2 top-0 size-[26%] -translate-x-1/2 -translate-y-1/2 shadow-xs ring-[0.75cqi] ring-background" />
        </span>
      ) : null}
    </span>
  )
}
