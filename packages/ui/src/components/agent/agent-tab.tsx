import { useMemo, useState } from 'react'
import { FileDiff, MessageSquare, Users } from 'lucide-react'

import type { RewindResult, SessionRef, Worktree } from '@canopy/shared'
import type { Turn } from '@canopy/shared/agent-stream'
import { AgentEventType, isEvent } from '@canopy/shared/agent-stream'

import { ErrorNote } from '@/components/error-note'
import { PanelShell, type PanelDef, type PanelRequest } from '@/components/panel-shell'
import { SegmentedControl, SegmentedControlOption } from '@/components/ui/segmented-control'
import { useIsMobile } from '@/components/ui/sidebar/sidebar-provider'
import { useAgentEdits, useDiffFiles, useProviders, useWorktrees } from '@/lib/api-hooks'
import { PaneSplitDirection, createAppShellLayout, setSplitWeights, splitPane, type AppShellLayout } from '@/lib/app-shell-layout'
import { NO_MESSAGE_ID, rewindInputFor } from '@/lib/rewind'
import { filesByTurn, mergeTurns, resolveTurn, snapshotsByTurn, type Checkout, type TurnEntry, type TurnPick } from '@/lib/turn-changes'
import { useTranscriptModel } from '@/lib/use-transcript-model'
import type { WorktreeAgent } from '@/lib/use-worktree-agent'

import { AgentComposer } from './composer'
import { NewSessionButton } from './new-session-button'
import { RewindDialog } from './rewind-dialog'
import { SessionRail } from './session-rail'
import { TranscriptView, type TurnWrites } from './transcript'
import { TurnChanges, type TurnReview } from './turn-changes'

const LAYOUT_KEY = 'canopy-agent-layout-v3'

type PanelId = 'sessions' | 'conversation' | 'changes'

/** Sessions | conversation, 1 : 3. The changes panel opens on demand to the right of the conversation. */
function buildAgentLayout(): AppShellLayout {
  const layout = createAppShellLayout({ initialPaneId: 'pane-sessions', views: ['sessions'], openDocks: [] })
  const split = splitPane(layout, { paneId: 'pane-sessions', direction: PaneSplitDirection.Right, newPaneId: 'pane-conversation', views: ['conversation'] })
  return setSplitWeights(split, { splitId: 'split:pane-conversation', weights: [0.25, 0.75] })
}

function emptyMessage(agent: WorktreeAgent, worktree: Worktree): string {
  if (agent.fresh) return `New ${agent.fresh === 'claude' ? 'Claude Code' : 'Codex'} session in ${worktree.path}. Your first message starts it.`
  if (agent.loading) return 'Looking for agent sessions that ran in this worktree…'
  if (agent.sessions.length === 0) return `No Claude Code or Codex session has run in ${worktree.path} yet. Start one there and it shows up here.`
  if (agent.history.isPending) return 'Loading transcript…'
  return 'No conversation yet. Comment on the Git Diff and send it for review, or ask the agent something about this worktree.'
}

const promptOf = (turn: Turn | undefined): string =>
  turn?.prompt && isEvent(turn.prompt, AgentEventType.UserMessage) ? turn.prompt.payload.text.trim() : ''

/** How a checkout is named on the pill and in the panel header: its branch, or its name without one. */
const labelOf = (worktree: Worktree): string => worktree.branch ?? worktree.name

const toReview = (entry: TurnEntry | undefined, turn: Turn | undefined, location: string | undefined): TurnReview => ({
  prompt: promptOf(turn),
  files: entry?.files ?? [],
  ...(entry?.snapshot ? { snapshot: entry.snapshot } : {}),
  ...(location ? { location } : {}),
  elsewhere: entry?.elsewhere ?? 0
})

export function AgentTab({ worktree, agent }: { worktree: Worktree; agent: WorktreeAgent }): React.JSX.Element {
  const changes = useDiffFiles(worktree.id, { kind: 'worktree', against: 'head' })
  const providers = useProviders()
  const model = useTranscriptModel(agent.history.data, agent.turn)
  const turns = model.transcript.turns
  const sessionRef: SessionRef | undefined = useMemo(
    () => (agent.selected ? { provider: agent.selected.provider, sessionId: agent.selected.sessionId } : undefined),
    [agent.selected?.provider, agent.selected?.sessionId]
  )
  const edits = useAgentEdits(sessionRef)
  // A session is listed under the worktree it runs in, but a turn may write anywhere Canopy
  // manages — a session run from the main checkout typically works in a worktree of its own — so
  // writes are attributed to whichever checkout holds them. This one comes first: it is the one
  // on screen, and what a relative path is relative to.
  const worktrees = useWorktrees()
  const checkouts = useMemo<Checkout[]>(
    () => [worktree, ...(worktrees.data ?? []).filter((other) => other.id !== worktree.id)].map(({ id, path }) => ({ id, path })),
    [worktree.id, worktree.path, worktrees.data]
  )
  const checkoutById = (id: string): Worktree => (id === worktree.id ? worktree : (worktrees.data?.find((other) => other.id === id) ?? worktree))
  // Exact snapshots (hooks) win; the transcript's named files fill in for turns without them.
  const byTurn = useMemo(
    () => mergeTurns(filesByTurn(turns, model.filesByCall, checkouts), snapshotsByTurn(turns, edits.data ?? []), worktree.id),
    [turns, model.filesByCall, checkouts, edits.data, worktree.id]
  )
  const writesByTurn = useMemo<ReadonlyMap<string, TurnWrites>>(
    () =>
      new Map(
        [...byTurn].map(([key, entry]) => [
          key,
          { count: entry.files.length + entry.elsewhere, ...(entry.worktreeId === worktree.id ? {} : { location: labelOf(checkoutById(entry.worktreeId)) }) }
        ])
      ),
    [byTurn, worktree.id, worktrees.data]
  )

  // The changes panel follows the newest turn until a specific one is picked.
  const [pick, setPick] = useState<TurnPick>('latest')
  const turnKey = resolveTurn(pick, byTurn)
  const pickedTurn = turnKey ? turns.find((turn) => turn.key === turnKey) : undefined
  const pickedEntry = turnKey ? byTurn.get(turnKey) : undefined
  // The checkout the picked turn's diff is read against — and rewound in — which need not be this one.
  const target = pickedEntry ? checkoutById(pickedEntry.worktreeId) : worktree
  const review = turnKey ? toReview(pickedEntry, pickedTurn, target.id === worktree.id ? undefined : labelOf(target)) : undefined
  const latestCount = writesByTurn.get(resolveTurn('latest', byTurn) ?? '')?.count ?? 0

  // Rewinding the picked turn: addressed by the provider's id for its prompt, and restored from the
  // hook snapshot when one was recorded. Null means this turn cannot be rewound at all.
  const rewindInput = useMemo(
    () => rewindInputFor(pickedTurn, model.extras, pickedEntry?.snapshot, target.path),
    [pickedTurn, model.extras, pickedEntry, target.path]
  )
  const [rewindOpen, setRewindOpen] = useState(false)
  // Kept with the turn it ran on, so picking another turn does not inherit its confirmation line.
  const [rewound, setRewound] = useState<{ turnKey: string; result: RewindResult }>()

  // Picking a turn must show it: the changes panel reopens if closed (desktop) or becomes the shown panel (phone).
  const [request, setRequest] = useState<PanelRequest>()
  const [mobilePanel, setMobilePanel] = useState<PanelId>('conversation')
  const mobile = useIsMobile()
  const [visible, setVisible] = useState<string[]>([])
  const changesShown = mobile ? mobilePanel === 'changes' : visible.includes('changes')
  const showChanges = (action: PanelRequest['action']): void => {
    setRequest({ id: 'changes', action, nonce: Date.now() })
    setMobilePanel(action === 'open' || (action === 'toggle' && !changesShown) ? 'changes' : 'conversation')
  }
  /** A hover action pins that turn and makes sure the panel is on screen. */
  const show = (next: TurnPick): void => {
    setPick(next)
    showChanges('open')
  }
  /** The transcript's rewind action: same pin, same panel, and the confirm dialog straight away. */
  const askRewind = (next: TurnPick): void => {
    show(next)
    setRewindOpen(true)
  }

  // Text quoted out of the transcript, on its way to the composer, which clears it once it is a chip.
  // The id makes a repeat quote of the same passage its own request rather than a no-op.
  const [quote, setQuote] = useState<{ id: number; text: string }>()

  const panels: PanelDef[] = [
    {
      id: 'sessions',
      title: 'Sessions',
      icon: Users,
      render: () => (
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex justify-end border-b border-border px-2 py-1">
            <NewSessionButton providers={providers.data ?? []} active={agent.fresh} onStart={agent.startSession} disabled={agent.turn.busy} />
          </div>
          <SessionRail sessions={agent.sessions} selected={agent.selected} onSelect={agent.select} className="min-h-0 flex-1" />
        </div>
      )
    },
    {
      id: 'conversation',
      title: 'Conversation',
      icon: MessageSquare,
      render: () => (
        <div className="flex h-full min-h-0 flex-col gap-2 p-2">
          <ErrorNote error={agent.error ?? agent.history.error ?? agent.turn.error} />
          <TranscriptView
            transcript={model.transcript}
            previews={model.previews}
            extras={model.extras}
            pending={agent.turn.pending}
            queued={agent.turn.queued}
            streamingText={agent.turn.streamingText}
            activity={agent.turn.activity}
            startedAt={agent.turn.startedAt}
            tokens={agent.turn.tokens}
            usage={agent.turn.usage}
            avatarSeed={agent.selected?.sessionId ?? worktree.id}
            capabilities={agent.capabilities}
            emptyMessage={emptyMessage(agent, worktree)}
            writesByTurn={writesByTurn}
            openInTerminal={agent.history.data?.openInTerminal}
            onReviewTurn={show}
            onRewindTurn={sessionRef ? askRewind : undefined}
            onAnswerPermission={agent.turn.answerPermission}
            onPickModel={agent.setModel}
            onQuote={(text) => setQuote({ id: Date.now(), text })}
            className="min-h-0 flex-1"
          />
          <AgentComposer
            agent={agent}
            changedFiles={changes.data?.files ?? []}
            placeholder={`Ask the agent about ${worktree.branch ?? worktree.name}`}
            latestChanges={{ count: latestCount, shown: changesShown, onToggle: () => showChanges('toggle') }}
            quote={quote}
            onQuoteStaged={() => setQuote(undefined)}
            context={model.context}
          />
        </div>
      )
    },
    {
      id: 'changes',
      title: 'Changes',
      icon: FileDiff,
      render: () =>
        review ? (
          <TurnChanges
            worktree={target}
            review={review}
            rewind={{
              onRewind: () => setRewindOpen(true),
              ...(rewindInput ? {} : { disabledReason: NO_MESSAGE_ID }),
              ...(rewound && rewound.turnKey === turnKey ? { done: rewound.result } : {})
            }}
            className="h-full"
          />
        ) : (
          <p className="p-4 text-xs text-muted-foreground">No turn has changed files yet. Each user message that made the agent write files gets its diff here.</p>
        )
    }
  ]

  const rewindDialog = (
    <RewindDialog
      worktreeId={target.id}
      session={sessionRef}
      input={rewindInput}
      prompt={review?.prompt ?? ''}
      open={rewindOpen && rewindInput !== null}
      onOpenChange={setRewindOpen}
      onRewound={(result) => setRewound(turnKey ? { turnKey, result } : undefined)}
    />
  )

  if (mobile) {
    const current = panels.find((panel) => panel.id === mobilePanel) ?? panels[1]
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        {rewindDialog}
        <SegmentedControl value={mobilePanel} onValueChange={(value) => setMobilePanel(value as PanelId)} aria-label="Agent panel" className="w-full">
          {panels.map((panel) => (
            <SegmentedControlOption key={panel.id} value={panel.id} className="flex-1">
              {panel.title}
            </SegmentedControlOption>
          ))}
        </SegmentedControl>
        <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-card">{current?.render()}</div>
      </div>
    )
  }

  return (
    <>
      {rewindDialog}
      <PanelShell storageKey={LAYOUT_KEY} buildDefaultLayout={buildAgentLayout} panels={panels} request={request} onVisibleChange={setVisible} className="min-h-0 flex-1" />
    </>
  )
}
