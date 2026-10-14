import { useEffect, useMemo, useState } from 'react'
import { BookOpen, FileCode2, FileDiff, MessageSquare, Presentation, SquareStack, Users } from 'lucide-react'

import type { AgentProvider, RewindResult, SessionRef, Worktree } from '@canopy/shared'
import type { Turn } from '@canopy/shared/agent-stream'
import { AgentEventType, isEvent } from '@canopy/shared/agent-stream'

import { ReaderPane, useReader } from '@/components/github/issues-browser'
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
import { useWhiteboard } from '@/lib/use-whiteboard'

import type { PreviewedAttachment } from './attachment-preview'
import { Conversation } from './conversation'
import { NewSessionButton } from './new-session-button'
import { RewindDialog } from './rewind-dialog'
import { ProviderIcon } from './provider-icon'
import { SessionPane } from './session-pane'
import { SessionRail, sessionTitle } from './session-rail'
import type { TurnWrites } from './transcript'
import { TurnChanges, type TurnReview } from './turn-changes'
import { BoardPane } from './whiteboard/board-pane'
import { CodePane } from './whiteboard/code-pane'
import { PlanReading } from './whiteboard/plan-reading'
import { Whiteboard } from './whiteboard/whiteboard'

/** Panels a saved arrangement keeps; the Reader's tabs do not survive a reload, so neither does it. */
const SAVED_PANELS = new Set(['sessions', 'conversation', 'changes', 'whiteboard'])

/** A board opened beside the whiteboard is a panel of its own, named for the board. */
const BOARD_PANEL = 'board:'
const boardPanelId = (board: string): string => `${BOARD_PANEL}${board}`

const LAYOUT_KEY = 'canopy-agent-layout-v3'

const REMOVED_CHECKOUT = 'This session ran in a worktree that has been removed'

type PanelId = 'sessions' | 'conversation' | 'changes' | 'reader' | 'whiteboard' | 'code'

/** Sessions | conversation, 1 : 3. The changes panel opens on demand to the right of the conversation. */
function buildAgentLayout(): AppShellLayout {
  const layout = createAppShellLayout({ initialPaneId: 'pane-sessions', views: ['sessions'], openDocks: [] })
  const split = splitPane(layout, { paneId: 'pane-sessions', direction: PaneSplitDirection.Right, newPaneId: 'pane-conversation', views: ['conversation'] })
  return setSplitWeights(split, { splitId: 'split:pane-conversation', weights: [0.25, 0.75] })
}

const promptOf = (turn: Turn | undefined): string => (turn?.prompt && isEvent(turn.prompt, AgentEventType.UserMessage) ? turn.prompt.payload.text.trim() : '')

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
  const sessionRef: SessionRef | undefined = useMemo(() => (agent.selected ? { provider: agent.selected.provider, sessionId: agent.selected.sessionId } : undefined), [agent.selected?.provider, agent.selected?.sessionId])
  const edits = useAgentEdits(sessionRef)
  // A session is listed under the worktree it runs in, but a turn may write anywhere Canopy
  // manages — a session run from the main checkout typically works in a worktree of its own — so
  // writes are attributed to whichever checkout holds them. This one comes first: it is the one
  // on screen, and what a relative path is relative to.
  const worktrees = useWorktrees()
  const checkouts = useMemo<Checkout[]>(() => [worktree, ...(worktrees.data ?? []).filter((other) => other.id !== worktree.id)].map(({ id, path }) => ({ id, path })), [worktree.id, worktree.path, worktrees.data])
  const checkoutById = (id: string): Worktree => (id === worktree.id ? worktree : (worktrees.data?.find((other) => other.id === id) ?? worktree))
  // Exact snapshots (hooks) win; the transcript's named files fill in for turns without them.
  const byTurn = useMemo(() => mergeTurns(filesByTurn(turns, model.filesByCall, checkouts), snapshotsByTurn(turns, edits.data ?? []), worktree.id), [turns, model.filesByCall, checkouts, edits.data, worktree.id])
  const writesByTurn = useMemo<ReadonlyMap<string, TurnWrites>>(
    () => new Map([...byTurn].map(([key, entry]) => [key, { count: entry.files.length + entry.elsewhere, ...(entry.worktreeId === worktree.id ? {} : { location: labelOf(checkoutById(entry.worktreeId)) }) }])),
    [byTurn, worktree.id, worktrees.data]
  )

  // The changes panel follows the newest turn until a specific one is picked.
  const [pick, setPick] = useState<TurnPick>('latest')
  const turnKey = resolveTurn(pick, byTurn)
  const pickedTurn = turnKey ? turns.find((turn) => turn.key === turnKey) : undefined
  const pickedEntry = turnKey ? byTurn.get(turnKey) : undefined
  // The checkout the picked turn's diff is read against — and rewound in — which need not be this one.
  const target = pickedEntry ? checkoutById(pickedEntry.worktreeId) : worktree
  // Narrowed to a box's files when its changes were asked for; a turn picked by hand shows all of its own.
  const [only, setOnly] = useState<string[]>()
  const whole = turnKey ? toReview(pickedEntry, pickedTurn, target.id === worktree.id ? undefined : labelOf(target)) : undefined
  const review = whole && only ? { ...whole, files: whole.files.filter((file) => only.includes(file)) } : whole
  const latestCount = writesByTurn.get(resolveTurn('latest', byTurn) ?? '')?.count ?? 0

  // Rewinding the picked turn: addressed by the provider's id for its prompt, and restored from the
  // hook snapshot when one was recorded. Null means this turn cannot be rewound at all.
  // A removed worktree's files are gone with it: there is nothing to put back, and restoring its
  // checkpoints against the checkout on screen would write into the wrong tree.
  const removed = agent.selected?.origin?.kind === 'removed'
  const rewindInput = useMemo(() => (removed ? null : rewindInputFor(pickedTurn, model.extras, pickedEntry?.snapshot, target.path)), [removed, pickedTurn, model.extras, pickedEntry, target.path])
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
    setOnly(undefined)
    setPick(next)
    showChanges('open')
  }
  /** What the build did to one box: the newest turn that wrote any of its files, narrowed to them. */
  const showFiles = (files: string[]): void => {
    const wrote = [...byTurn].reverse().find(([, entry]) => entry.files.some((file) => files.includes(file)))?.[0]
    setOnly(files)
    setPick(wrote ?? 'latest')
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
    // A layout saved in another worktree can name a session this one does not have; the pane composes a new one instead.
    if (!ref || (!summary && !agent.loading)) return undefined
    return {
      id: viewId,
      title: summary ? sessionTitle(summary) : ref.sessionId.slice(0, 8),
      icon: MessageSquare,
      render: () => <SessionPane worktree={worktree} session={ref} changedFiles={changedFiles} onOpenAttachment={openAttachment} onOpenIssue={openIssue} />
    }
  }
  const openBeside = (ref: SessionRef): void => setRequest({ id: sessionPanelId(ref), action: 'open', nonce: Date.now() })

  // Issues and attachments opened from any composer here — chips, links inside an issue — are read
  // in one Reader panel to the right, a tab each.
  const reader = useReader()
  const openAttachment = (next: PreviewedAttachment): void => {
    reader.show(next.issue !== undefined ? { kind: 'issue', number: next.issue } : { kind: 'staged', attachment: next })
    revealReader()
  }
  /** A `#123` the agent wrote: its tab, or with a modifier a new one. */
  const openIssue = (number: number, newTab: boolean): void => {
    reader.show({ kind: 'issue', number }, newTab)
    revealReader()
  }
  /** The plan, read beside the whiteboard instead of over it. */
  const readPlan = (): void => {
    reader.show({ kind: 'plan' })
    revealReader()
  }
  const revealReader = (): void => {
    setRequest({ id: 'reader', action: 'open', nonce: Date.now() })
    setMobilePanel('reader')
  }

  // A new session is composed in the main conversation, so that panel comes on screen with it.
  const startSession = (provider: AgentProvider): void => {
    agent.startSession(provider)
    setRequest({ id: 'conversation', action: 'open', nonce: Date.now() })
    setMobilePanel('conversation')
  }

  // Text quoted out of the transcript, on its way to the composer.
  const staging = useStaging()

  // The whiteboard: the boards this conversation drew, the code its boxes cite, and boards opened beside it.
  const whiteboard = useWhiteboard(agent, model)
  // A reference keeps the checkout it was opened from, so picking another session does not reread it in that one's.
  const [code, setCode] = useState<{ ref: string; worktreeId: string }>()
  const reveal = (id: string, panel?: PanelId, share?: number): void => {
    setRequest({ id, action: 'open', nonce: Date.now(), ...(share ? { share } : {}) })
    if (panel) setMobilePanel(panel)
  }
  // A box cites files relative to the checkout its session runs in, which need not be the one on screen.
  // Until the worktree list says which that is, a reference does not open: guessing this one would
  // read the file from the wrong checkout.
  const origin = agent.selected?.origin
  const codeWorktree = !origin ? worktree : worktrees.data ? (worktrees.data.find((other) => other.id === origin.worktreeId || other.path === origin.runIn) ?? worktree) : undefined
  const openRef = (ref: string): void => {
    if (!codeWorktree) return
    setCode({ ref, worktreeId: codeWorktree.id })
    reveal('code', 'code')
  }
  const openBoard = (board: string): void => reveal(boardPanelId(board), 'whiteboard')
  // Turning a mode on, or the first board arriving, brings the whiteboard on screen.
  const drawingOn = agent.whiteboard !== undefined
  const hasBoards = whiteboard.view.state.order.length > 0
  useEffect(() => {
    // Boards need room to be read: the whiteboard takes most of the conversation's width.
    if (drawingOn || hasBoards) reveal('whiteboard', undefined, 0.62)
  }, [drawingOn, hasBoards])
  const boardPanel = (viewId: string): PanelDef | undefined => {
    if (!viewId.startsWith(BOARD_PANEL)) return undefined
    const id = viewId.slice(BOARD_PANEL.length)
    const board = whiteboard.view.state.boards[id]
    return {
      id: viewId,
      title: board?.versions.at(-1)?.title ?? 'Board',
      icon: SquareStack,
      render: () => <BoardPane key={agent.selected?.sessionId ?? 'fresh'} whiteboard={whiteboard} boardId={id} turns={turns} busy={agent.turn.busy} onOpenBoard={openBoard} onOpenRef={openRef} onShowChanges={showFiles} />
    }
  }

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
          onOpenAttachment={openAttachment}
          onOpenIssue={openIssue}
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
    },
    {
      id: 'whiteboard',
      title: 'Whiteboard',
      icon: Presentation,
      render: () => (
        // Board ids repeat across sessions ("overview"), so what the reader moved or opened is per session.
        <Whiteboard
          key={agent.selected?.sessionId ?? 'fresh'}
          whiteboard={whiteboard}
          turns={turns}
          mode={agent.whiteboard}
          onMode={agent.setWhiteboard}
          busy={agent.turn.busy}
          onAnswerPermission={agent.turn.answerPermission}
          onOpenBeside={openBoard}
          onOpenRef={openRef}
          onShowChanges={showFiles}
          onReadPlan={readPlan}
        />
      )
    },
    ...(code ? [{ id: 'code', title: 'Code', icon: FileCode2, render: () => <CodePane worktreeId={code.worktreeId} codeRef={code.ref} /> }] : []),
    // Listed only once something has been opened, so the top bar does not offer an empty reader.
    ...(reader.state.tabs.length > 0
      ? [
          {
            id: 'reader',
            title: 'Reader',
            icon: BookOpen,
            render: () => <ReaderPane projectId={worktree.projectId} reader={reader} empty={null} plan={<PlanReading whiteboard={whiteboard} onAnswer={agent.turn.answerPermission} />} />
          }
        ]
      : [])
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
        <NewSessionButton providers={providers.data ?? []} active={agent.fresh} onStart={startSession} disabled={agent.turn.busy} />
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
        resolvePanel={(viewId) => boardPanel(viewId) ?? sessionPanel(viewId)}
        keepView={(viewId) => SAVED_PANELS.has(viewId) || parseSessionPanelId(viewId) !== undefined}
        renderEmpty={(place) =>
          // One composer on screen at a time: beside the main conversation an empty pane only says what it is for.
          visible.includes('conversation') ? (
            <p className="p-4 text-xs text-muted-foreground">Drag a session here from Sessions, or close this panel.</p>
          ) : (
            <SessionPane worktree={worktree} changedFiles={changedFiles} onCreated={(ref) => place(sessionPanelId(ref))} onOpenAttachment={openAttachment} onOpenIssue={openIssue} />
          )
        }
        request={request}
        onVisibleChange={setVisible}
        className="min-h-0 flex-1 rounded-none border-0"
      />
    </>
  )
}
