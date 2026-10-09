import { useEffect, useMemo, useRef, useState } from 'react'
import { Database, GitCompareArrows, Network, Radar, Repeat2, Workflow, type LucideIcon } from 'lucide-react'

import type { SessionRef, Worktree } from '@canopy/shared'

import { Conversation, type Starter } from '@/components/agent/conversation'
import type { OpenFileRef } from '@/components/agent/answer-links'
import { sessionTitle } from '@/components/agent/session-rail'
import { useDiffFiles } from '@/lib/api-hooks'
import { DIAGRAM_SPECS, GIT_AGENT_INSTRUCTIONS, agentStatus, diagramPrompt, type AgentStatus, type AgentTab } from '@/lib/git-agent'
import type { Outgoing } from '@/lib/use-git-agent'
import type { Staging } from '@/lib/use-staging'
import { useTranscriptModel } from '@/lib/use-transcript-model'
import { sameRef, useWorktreeAgent } from '@/lib/use-worktree-agent'
import { cn } from '@/lib/utils'

const PROVIDER_NAME = { claude: 'Claude', codex: 'Codex' } as const

/** Each diagram's mark: an icon in a tint of its own, so the six read apart at a glance. */
const DIAGRAM_LOOK: Record<string, { icon: LucideIcon; tint: string }> = {
  'change-map': { icon: Network, tint: 'bg-sky-500/12 text-sky-600 dark:text-sky-400' },
  'call-flow': { icon: Workflow, tint: 'bg-violet-500/12 text-violet-600 dark:text-violet-400' },
  'blast-radius': { icon: Radar, tint: 'bg-amber-500/12 text-amber-600 dark:text-amber-400' },
  'before-after': { icon: GitCompareArrows, tint: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400' },
  state: { icon: Repeat2, tint: 'bg-rose-500/12 text-rose-600 dark:text-rose-400' },
  'data-model': { icon: Database, tint: 'bg-teal-500/12 text-teal-600 dark:text-teal-400' }
}

function DiagramMark({ id }: { id: string }): React.JSX.Element | null {
  const look = DIAGRAM_LOOK[id]
  if (!look) return null
  const Icon = look.icon
  return (
    <span className={cn('flex size-7 items-center justify-center rounded-md', look.tint)}>
      <Icon className="size-4" />
    </span>
  )
}

/** What the tab strip shows for one conversation. */
export interface TabMeta {
  title: string
  status: AgentStatus
  /** The painted identity of the session — the same one its answers carry. */
  seed: string
  running: boolean
}

/**
 * One Git Agent tab: a conversation of its own, mounted for as long as the tab is open so a turn
 * keeps streaming while another tab is on screen. It never follows or moves the worktree's pinned
 * session. It reports what the strip needs, and sends what is queued for it — a review, a task
 * another pane started — once its conversation is the one that names and free to take it.
 */
export function GitAgentConversation({
  worktree,
  tab,
  onOpenRef,
  active,
  staging,
  outgoing,
  onSent,
  onSession,
  onMeta
}: {
  worktree: Worktree
  tab: AgentTab
  onOpenRef: OpenFileRef
  active: boolean
  staging: Staging
  outgoing?: Outgoing
  onSent: () => void
  onSession: (session: SessionRef) => void
  onMeta: (meta: TabMeta) => void
}): React.JSX.Element {
  const agent = useWorktreeAgent(worktree, undefined, { follow: false, instructions: GIT_AGENT_INSTRUCTIONS })
  const model = useTranscriptModel(agent.history.data, agent.turn)
  const where = worktree.branch ?? worktree.name
  const starter = useMemo<Starter>(
    () => ({
      title: 'Ask about this change',
      note: `A new ${PROVIDER_NAME[tab.provider]} session on ${where}. Pick a picture of the change to start, or ask anything below.`,
      suggestions: DIAGRAM_SPECS.map((spec) => ({ id: spec.id, label: spec.label, hint: spec.hint, icon: <DiagramMark id={spec.id} />, prompt: diagramPrompt(spec, tab.provider) }))
    }),
    [tab.provider, where]
  )
  const files = useDiffFiles(worktree.id, { kind: 'worktree', against: 'head' }).data

  // Open the tab's own conversation, or start composing one with its provider.
  useEffect(() => {
    if (agent.loading || agent.selected || agent.fresh) return
    if (tab.session && [...agent.sessions, ...agent.elsewhere].some((s) => sameRef(s, tab.session))) agent.select(tab.session)
    else agent.startSession(tab.provider)
  }, [agent.loading, agent.selected, agent.fresh])

  // A new conversation is this tab's from its first event, not only once that first turn ends, so a
  // reload mid-turn — a long grouping, a diagram — finds the tab again while the daemon finishes it.
  const own = agent.selected ?? (agent.fresh && agent.turn.sessionId ? { provider: agent.fresh, sessionId: agent.turn.sessionId } : undefined)
  useEffect(() => {
    if (own) onSession({ provider: own.provider, sessionId: own.sessionId })
  }, [own?.provider, own?.sessionId])

  const target = outgoing?.target
  const ready = target !== undefined && !agent.turn.busy && (target.sessionId ? agent.selected?.sessionId === target.sessionId : agent.fresh === target.provider)
  useEffect(() => {
    if (!outgoing || !ready) return
    onSent()
    void (outgoing.kind === 'review'
      ? agent.turn.sendReview(outgoing.target, outgoing.request, outgoing.summary)
      : agent.turn.sendMessage(outgoing.text))
  }, [outgoing, ready])

  // A finish is news until the tab is looked at: finishing in view counts as read.
  const [unseen, setUnseen] = useState(false)
  const wasBusy = useRef(agent.turn.busy)
  useEffect(() => {
    if (wasBusy.current && !agent.turn.busy && !active) setUnseen(true)
    wasBusy.current = agent.turn.busy
  }, [agent.turn.busy])
  useEffect(() => {
    if (active) setUnseen(false)
  }, [active])

  const asking = model.transcript.pendingAsks.some((ask) => ask.agentPath.length === 0)
  const status = agentStatus({ busy: agent.turn.busy, asking, error: Boolean(agent.turn.error), unseen })
  const title = agent.selected ? sessionTitle(agent.selected) : `New ${PROVIDER_NAME[tab.provider]} session`
  const seed = agent.selected?.sessionId ?? tab.id
  useEffect(() => onMeta({ title, status, seed, running: agent.turn.busy }), [title, status, seed, agent.turn.busy])

  return (
    <div className={cn('h-full min-h-0', !active && 'hidden')}>
      <Conversation worktree={worktree} agent={agent} model={model} changedFiles={files && 'files' in files ? files.files : []} staging={staging} avatarSeed={seed} onOpenRef={onOpenRef} starter={starter} />
    </div>
  )
}
