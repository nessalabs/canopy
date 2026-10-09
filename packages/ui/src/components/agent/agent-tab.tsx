import { useMemo, useState } from 'react'
import { FileDiff, MessageSquare, Users } from 'lucide-react'

import type { RewindResult, SessionRef, Worktree } from '@canopy/shared'
import type { Turn } from '@canopy/shared/agent-stream'
import { AgentEventType, isEvent } from '@canopy/shared/agent-stream'

import { PanelShell, type PanelDef, type PanelRequest } from '@/components/panel-shell'
import { ShellSlot } from '@/components/shell-slots'
import { SegmentedControl, SegmentedControlOption } from '@/components/ui/segmented-control'
import { useIsMobile } from '@/components/ui/sidebar/sidebar-provider'
import { useAgentEdits, useDiffFiles, useProviders, useWorktrees } from '@/lib/api-hooks'
import { PaneSplitDirection, createAppShellLayout, setSplitWeights, splitPane, type AppShellLayout } from '@/lib/app-shell-layout'
import { NO_MESSAGE_ID, rewindInputFor } from '@/lib/rewind'
import { parseSessionPanelId, sessionPanelId } from '@/lib/session-panels'
import { filesByTurn, mergeTurns, resolveTurn, snapshotsByTurn, type Checkout, type TurnEntry, type TurnPick } from '@/lib/turn-changes'
import { useStaging } from '@/lib/use-staging'
import { useTranscriptModel } from '@/lib/use-transcript-model'
import type { WorktreeAgent } from '@/lib/use-worktree-agent'

import { Conversation } from './conversation'
import { NewSessionButton } from './new-session-button'
import { RewindDialog } from './rewind-dialog'
import { ProviderIcon } from './provider-icon'
import { SessionPane } from './session-pane'
import { SessionRail, sessionTitle } from './session-rail'
import type { TurnWrites } from './transcript'
import { TurnChanges, type TurnReview } from './turn-changes'

const LAYOUT_KEY = 'canopy-agent-layout-v3'

const REMOVED_CHECKOUT = 'This session ran in a worktree that has been removed'

type PanelId = 'sessions' | 'conversation' | 'changes'

/** Sessions | conversation, 1 : 3. The changes panel opens on demand to the right of the conversation. */
function buildAgentLayout(): AppShellLayout {
  const layout = createAppShellLayout({ initialPaneId: 'pane-sessions', views: ['sessions'], openDocks: [] })
  const split = splitPane(layout, { paneId: 'pane-sessions', direction: PaneSplitDirection.Right, newPaneId: 'pane-conversation', views: ['conversation'] })
  return setSplitWeights(split, { splitId: 'split:pane-conversation', weights: [0.25, 0.75] })
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
  // A removed worktree's files are gone with it: there is nothing to put back, and restoring its
  // checkpoints against the checkout on screen would write into the wrong tree.
  const removed = agent.selected?.origin?.kind === 'removed'
  const rewindInput = useMemo(
    () => (removed ? null : rewindInputFor(pickedTurn, model.extras, pickedEntry?.snapshot, target.path)),
    [removed, pickedTurn, model.extras, pickedEntry, target.path]
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

  // Sessions opened beside the main conversation are panels made on demand, one per session.
  const everySession = [...agent.sessions, ...agent.elsewhere]
  const changedFiles = changes.data?.files ?? []
  const sessionPanel = (viewId: string): PanelDef | undefined => {
    const ref = parseSessionPanelId(viewId)
    const summary = ref && everySession.find((s) => s.provider === ref.provider && s.sessionId === ref.sessionId)
    if (!ref) return undefined
    return { id: viewId, title: summary ? sessionTitle(summary) : ref.sessionId.slice(0, 8), icon: MessageSquare, render: () => <SessionPane worktree={worktree} session={ref} changedFiles={changedFiles} /> }
  }
  const openBeside = (ref: SessionRef): void => setRequest({ id: sessionPanelId(ref), action: 'open', nonce: Date.now() })

  // Text quoted out of the transcript, on its way to the composer.
  const staging = useStaging()

  const panels: PanelDef[] = [
    {
      id: 'sessions',
      title: 'Sessions',
      icon: Users,
      render: () => (
        <SessionRail
          sessions={agent.sessions}
          elsewhere={agent.elsewhere}
          branch={worktree.branch}
          selected={agent.selected}
          onSelect={agent.select}
          onOpenBeside={mobile ? undefined : openBeside}
          className="h-full min-h-0"
        />
      )
    },
    {
      id: 'conversation',
      title: 'Conversation',
      icon: MessageSquare,
      render: () => (
        <Conversation
          worktree={worktree}
          agent={agent}
          model={model}
          changedFiles={changes.data?.files ?? []}
          changes={{
            writesByTurn,
            onReviewTurn: show,
            onRewindTurn: sessionRef && !removed ? askRewind : undefined,
            latestChanges: { count: latestCount, shown: changesShown, onToggle: () => showChanges('toggle') }
          }}
          staging={staging}
        />
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
              ...(rewindInput ? {} : { disabledReason: removed ? REMOVED_CHECKOUT : NO_MESSAGE_ID }),
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

  // The top bar names the conversation on screen, as Git's tabs name its view.
  const provider = agent.selected?.provider ?? agent.fresh
  const chrome = (
    <>
      {provider ? (
        <ShellSlot name="view">
          <span className="flex min-w-0 items-center gap-2 text-sm">
            <ProviderIcon provider={provider} className="size-4 shrink-0" />
            <span className="truncate font-medium">{agent.selected ? sessionTitle(agent.selected) : 'New session'}</span>
          </span>
        </ShellSlot>
      ) : null}
      <ShellSlot name="actions">
        <NewSessionButton providers={providers.data ?? []} active={agent.fresh} onStart={agent.startSession} disabled={agent.turn.busy} />
      </ShellSlot>
    </>
  )

  if (mobile) {
    const current = panels.find((panel) => panel.id === mobilePanel) ?? panels[1]
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
        {rewindDialog}
        {chrome}
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
      {chrome}
      <PanelShell
        storageKey={LAYOUT_KEY}
        buildDefaultLayout={buildAgentLayout}
        panels={panels}
        resolvePanel={sessionPanel}
        renderEmpty={(place) => (
          <div className="flex h-full min-h-0 flex-col">
            <p className="px-4 pt-3 text-xs text-muted-foreground">Open a session here — or drag one in from Sessions.</p>
            <SessionRail sessions={agent.sessions} elsewhere={agent.elsewhere} branch={worktree.branch} onSelect={(ref) => place(sessionPanelId(ref))} className="min-h-0 flex-1" />
          </div>
        )}
        request={request}
        onVisibleChange={setVisible}
        className="min-h-0 flex-1 rounded-none border-0"
      />
    </>
  )
}
