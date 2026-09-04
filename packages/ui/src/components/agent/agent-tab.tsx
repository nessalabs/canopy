import { useMemo, useState } from 'react'
import { FileDiff, MessageSquare, RotateCcw, Users } from 'lucide-react'

import type { Worktree } from '@canopy/shared'
import type { Turn } from '@canopy/shared/agent-stream'
import { AgentEventType, isEvent } from '@canopy/shared/agent-stream'

import { ErrorNote } from '@/components/error-note'
import { PanelShell, type PanelDef, type PanelRequest } from '@/components/panel-shell'
import { Button } from '@/components/ui/button'
import { SegmentedControl, SegmentedControlOption } from '@/components/ui/segmented-control'
import { useIsMobile } from '@/components/ui/sidebar/sidebar-provider'
import { useAgentEdits, useDiffFiles, useProviders } from '@/lib/api-hooks'
import { PaneSplitDirection, createAppShellLayout, setSplitWeights, splitPane, type AppShellLayout } from '@/lib/app-shell-layout'
import { filesByTurn, mergeTurns, resolveTurn, snapshotsByTurn, type TurnEntry, type TurnPick } from '@/lib/turn-changes'
import { useTranscriptModel } from '@/lib/use-transcript-model'
import type { WorktreeAgent } from '@/lib/use-worktree-agent'

import { AgentComposer } from './composer'
import { NewSessionButton } from './new-session-button'
import { SessionRail } from './session-rail'
import { TranscriptView } from './transcript'
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

const toReview = (entry: TurnEntry | undefined, turn: Turn | undefined): TurnReview => ({
  prompt: promptOf(turn),
  files: entry?.files ?? [],
  ...(entry?.snapshot ? { snapshot: entry.snapshot } : {})
})

export function AgentTab({ worktree, agent }: { worktree: Worktree; agent: WorktreeAgent }): React.JSX.Element {
  const changes = useDiffFiles(worktree.id, { kind: 'worktree', against: 'head' })
  const providers = useProviders()
  const model = useTranscriptModel(agent.history.data, agent.turn)
  const turns = model.transcript.turns
  const edits = useAgentEdits(agent.selected ? { provider: agent.selected.provider, sessionId: agent.selected.sessionId } : undefined)
  // Exact snapshots (hooks) win; the transcript's named files fill in for turns without them.
  const byTurn = useMemo(
    () => mergeTurns(filesByTurn(turns, model.filesByCall, worktree.path), snapshotsByTurn(turns, edits.data ?? [])),
    [turns, model.filesByCall, worktree.path, edits.data]
  )
  const filesOnly = useMemo(() => new Map([...byTurn].map(([key, entry]) => [key, entry.files])), [byTurn])

  // The changes panel follows the newest turn until a specific one is picked.
  const [pick, setPick] = useState<TurnPick>('latest')
  const turnKey = resolveTurn(pick, byTurn)
  const review = turnKey ? toReview(byTurn.get(turnKey), turns.find((turn) => turn.key === turnKey)) : undefined
  const latestCount = byTurn.get(resolveTurn('latest', byTurn) ?? '')?.files.length ?? 0

  // Picking a turn must show it: the changes panel reopens if closed (desktop) or becomes the shown panel (phone).
  const [resetToken, setResetToken] = useState(0)
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
            streamingText={agent.turn.streamingText}
            activity={agent.turn.activity}
            startedAt={agent.turn.startedAt}
            tokens={agent.turn.tokens}
            avatarSeed={agent.selected?.sessionId ?? worktree.id}
            emptyMessage={emptyMessage(agent, worktree)}
            filesByTurn={filesOnly}
            openInTerminal={agent.history.data?.openInTerminal}
            onReviewTurn={show}
            className="min-h-0 flex-1"
          />
          <AgentComposer
            agent={agent}
            changedFiles={changes.data?.files ?? []}
            placeholder={`Ask the agent about ${worktree.branch ?? worktree.name}`}
            latestChanges={{ count: latestCount, shown: changesShown, onToggle: () => showChanges('toggle') }}
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
          <TurnChanges worktree={worktree} review={review} className="h-full" />
        ) : (
          <p className="p-4 text-xs text-muted-foreground">No turn has changed files yet. Each user message that made the agent write files gets its diff here.</p>
        )
    }
  ]

  if (mobile) {
    const current = panels.find((panel) => panel.id === mobilePanel) ?? panels[1]
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2">
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
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={() => setResetToken((n) => n + 1)}>
          <RotateCcw className="size-3.5" />
          Reset layout
        </Button>
      </div>
      <PanelShell storageKey={LAYOUT_KEY} buildDefaultLayout={buildAgentLayout} panels={panels} resetToken={resetToken} request={request} onVisibleChange={setVisible} className="min-h-0 flex-1" />
    </div>
  )
}
