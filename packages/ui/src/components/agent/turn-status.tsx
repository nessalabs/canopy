import { useEffect, useState } from 'react'

import { Message } from '@/components/ui/message'

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

/**
 * The live status row for a running turn: the agent's own avatar, moving the way the activity
 * says, then a verb that changes every few seconds and how long and how many tokens the turn
 * has taken so far. Gone when it ends.
 */
export function TurnStatus({ activity, startedAt, tokens, avatarSeed }: { activity: Activity; startedAt: number; tokens: number; avatarSeed: string }): React.JSX.Element {
  const now = useNow()
  const elapsed = Math.max(0, now - startedAt)
  const verb = VERBS[Math.floor(elapsed / VERB_PERIOD_MS) % VERBS.length]
  return (
    <Message from="assistant">
      <AgentAvatar seed={avatarSeed} name="Agent" activity={activity} className="size-8 self-end" />
      <span className="inline-flex min-h-8 items-center gap-2 font-mono text-[11px] text-muted-foreground">
        <span className="text-foreground/80">{verb}…</span>
        <span>
          ({formatElapsed(elapsed)}
          {tokens > 0 ? ` · ↓ ${formatTokens(tokens)} tokens` : ''})
        </span>
      </span>
    </Message>
  )
}
