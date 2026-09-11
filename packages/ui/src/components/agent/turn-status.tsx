import { useEffect, useState } from 'react'

import { AgentActivityCue } from '@/components/ui/agent-activity'

import { AgentAvatar, type Activity } from './agent-avatar'

/** Rotating stand-ins for "working", the way Claude Code's spinner narrates a long turn. */
const VERBS = ['Thinking', 'Pondering', 'Mulling', 'Tinkering', 'Churning', 'Cogitating', 'Noodling', 'Brewing', 'Percolating', 'Musing']
const VERB_PERIOD_MS = 6000

const formatElapsed = (ms: number): string => {
  const total = Math.floor(ms / 1000)
  const minutes = Math.floor(total / 60)
  return minutes > 0 ? `${minutes}m ${total % 60}s` : `${total}s`
}

const formatTokens = (tokens: number): string => (tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens))

/** Re-renders once a second while mounted so the elapsed readout ticks. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/** What a screen reader hears: the activity, when it changes — not the verb, not the clock. */
const ANNOUNCED: Record<Activity, string> = { thinking: 'Thinking…', working: 'Working…', solving: 'Solving…' }

/**
 * The live status row for a running turn, shaped like the activity cues above it: the agent's
 * avatar at cue size, flooding the way the activity says, a shimmering verb that changes every
 * few seconds, then how long and how many tokens the turn has taken. It sits in the content
 * column, not the avatar column — the answer's own avatar is already there, and two of the same
 * painting one above the other read as two agents. Gone when the turn ends.
 *
 * Only the activity is in the live region. The rotating verb and the ticking readout are for
 * eyes: announced, they would interrupt a screen reader every second for the whole turn, saying
 * nothing the activity did not already say.
 */
export function TurnStatus({ activity, startedAt, tokens, avatarSeed }: { activity: Activity; startedAt: number; tokens: number; avatarSeed: string }): React.JSX.Element {
  const now = useNow()
  const elapsed = Math.max(0, now - startedAt)
  const verb = VERBS[Math.floor(elapsed / VERB_PERIOD_MS) % VERBS.length]
  return (
    <div className="ml-10 flex min-w-0 items-center gap-1.5">
      <span role="status" className="sr-only">
        {ANNOUNCED[activity]}
      </span>
      <AgentActivityCue aria-hidden="true" status="running" icon={<AgentAvatar seed={avatarSeed} activity={activity} />}>
        {verb}…
      </AgentActivityCue>
      <span aria-hidden="true" className="nessa-text-2 tabular-nums text-muted-foreground/70">
        {formatElapsed(elapsed)}
        {tokens > 0 ? ` · ${formatTokens(tokens)} tokens` : ''}
      </span>
    </div>
  )
}
