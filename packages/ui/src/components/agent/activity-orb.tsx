import { ThinkingOrb, type OrbState } from 'thinking-orbs'

/** What the agent is doing right now, as the turn reducer tracks it. */
export type Activity = 'thinking' | 'working' | 'solving'

const ORB: Record<Activity, OrbState> = { thinking: 'searching', working: 'working', solving: 'solving' }
const LABEL: Record<Activity, string> = { thinking: 'Thinking', working: 'Working', solving: 'Solving' }

/** thinking-orbs indicator keyed by activity; `size` 20 is inline text scale, 64 avatar scale. */
export function ActivityOrb({ activity, size = 20 }: { activity: Activity; size?: 20 | 64 }): React.JSX.Element {
  return <ThinkingOrb state={ORB[activity]} size={size} aria-label={`${LABEL[activity]}…`} />
}
