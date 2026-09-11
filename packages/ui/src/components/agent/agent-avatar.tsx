import { RandomAvatar, type RandomAvatarGround } from '@/components/ui/random-avatar'
import { cn } from '@/lib/utils'

/** What the agent is doing right now, as the turn reducer tracks it. */
export type Activity = 'thinking' | 'working' | 'solving'

/**
 * How nessa's working flood is tuned per activity. `speed` multiplies the ~5s cycle; `flood`
 * is how far a wash expands, where 1 takes the whole paper and 0.25 only breathes. Thinking
 * is the quiet end — the paint barely stirs — and solving the urgent one.
 */
export const ACTIVITY_TUNING: Record<Activity, { speed: number; flood: number }> = {
  thinking: { speed: 0.7, flood: 0.4 },
  working: { speed: 1, flood: 1 },
  solving: { speed: 1.6, flood: 1 }
}

const LABEL: Record<Activity, string> = { thinking: 'thinking', working: 'working', solving: 'solving' }

export interface AgentAvatarProps {
  /** The identity the painting is derived from; the same seed as the transcript's other avatars. */
  seed: string
  /** Names the picture for assistive technology; the activity is appended while it runs. */
  name?: string
  /** What the agent is doing; `null` paints the avatar at rest. */
  activity?: Activity | null
  /** Overrides the activity's tuning, for trying values on the lab page. */
  speed?: number
  flood?: number
  bleed?: number
  ground?: RandomAvatarGround
  /** Size the box with `size-*`. */
  className?: string
}

/**
 * The agent's avatar, alive while the agent is: the same seeded painting the transcript shows
 * beside every answer, put into nessa's own working state — the washes flood the paper and hand
 * over to one another — with the pace and reach of the flood keyed to what the agent is doing.
 * At rest it is exactly the `RandomAvatar` the rest of the transcript uses.
 */
export function AgentAvatar({ seed, name, activity = null, speed, flood, bleed, ground, className }: AgentAvatarProps): React.JSX.Element {
  const tuning = activity ? ACTIVITY_TUNING[activity] : null
  return (
    <RandomAvatar
      data-slot="agent-avatar"
      data-activity={activity ?? undefined}
      seed={seed}
      name={name ? (activity ? `${name}, ${LABEL[activity]}` : name) : undefined}
      ground={ground}
      busy={activity !== null}
      speed={speed ?? tuning?.speed}
      flood={flood ?? tuning?.flood}
      bleed={bleed}
      className={cn('size-8', className)}
    />
  )
}
