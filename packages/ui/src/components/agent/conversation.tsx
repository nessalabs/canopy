import type { ChangedFile, SessionOrigin, Worktree } from '@canopy/shared'

import { ErrorNote } from '@/components/error-note'
import type { TranscriptModel } from '@/lib/use-transcript-model'
import type { WorktreeAgent } from '@/lib/use-worktree-agent'

import { AgentComposer } from './composer'
import { TranscriptView, type TurnWrites } from './transcript'

export function emptyMessage(agent: WorktreeAgent, worktree: Worktree): string {
  if (agent.fresh) return `New ${agent.fresh === 'claude' ? 'Claude Code' : 'Codex'} session in ${worktree.path}. Your first message starts it.`
  if (agent.loading) return 'Looking for agent sessions that ran in this worktree…'
  if (agent.sessions.length === 0) {
    const none = `No Claude Code or Codex session has run in ${worktree.path} yet. Start one there and it shows up here.`
    if (agent.elsewhere.length === 0) return none
    // The usual case for a fresh worktree: the conversation about its branch happened in the main checkout.
    const onBranch = worktree.branch ? agent.elsewhere.filter((s) => s.gitBranch === worktree.branch).length : 0
    if (onBranch > 0) return `${none} ${onBranch === 1 ? 'One session' : `${onBranch} sessions`} in the main checkout worked on ${worktree.branch}; pick one under Sessions to read or continue it.`
    return worktree.isMain ? `${none} Sessions from this project's other checkouts are listed under Sessions.` : `${none} The main checkout's sessions are listed under Sessions.`
  }
  if (agent.history.isPending) return 'Loading transcript…'
  return 'No conversation yet. Comment on the changes in the Git tab and send them for review, or ask the agent something about this worktree.'
}

/** Where a session from another checkout ran, and where a message to it will run. */
function OriginNote({ origin }: { origin: SessionOrigin }): React.JSX.Element {
  const where = origin.kind === 'main' ? 'the main checkout' : origin.name
  return (
    <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      {origin.kind === 'removed' ? (
        <>
          This session ran in <span className="font-mono">{origin.path}</span>, which has been removed. Its transcript is kept; a message continues it in{' '}
          <span className="font-mono">{origin.runIn}</span>.
        </>
      ) : (
        <>
          This session ran in {where} (<span className="font-mono">{origin.path}</span>). A message continues it there.
        </>
      )}
    </p>
  )
}

/**
 * How a conversation reaches the per-turn changes panel. Only the main conversation has one;
 * a session opened beside it reads and talks without it.
 */
export interface TurnChangesWiring {
  writesByTurn: ReadonlyMap<string, TurnWrites>
  onReviewTurn: (turnKey: string) => void
  onRewindTurn?: (turnKey: string) => void
  latestChanges: { count: number; shown: boolean; onToggle: () => void }
}

const NO_WRITES: ReadonlyMap<string, TurnWrites> = new Map()

/**
 * One conversation: its notes, the transcript and the composer under it — the same for the
 * Agent tab's main conversation and for every session opened beside it in its own pane.
 */
export function Conversation({
  worktree,
  agent,
  model,
  changedFiles,
  changes,
  quote,
  onQuote,
  onQuoteStaged
}: {
  worktree: Worktree
  agent: WorktreeAgent
  model: TranscriptModel
  changedFiles: ChangedFile[]
  changes?: TurnChangesWiring
  quote?: { id: number; text: string }
  onQuote?: (text: string) => void
  onQuoteStaged?: () => void
}): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      <ErrorNote error={agent.error ?? agent.history.error ?? agent.turn.error} />
      {agent.selected?.origin ? <OriginNote origin={agent.selected.origin} /> : null}
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
        writesByTurn={changes?.writesByTurn ?? NO_WRITES}
        openInTerminal={agent.history.data?.openInTerminal}
        onReviewTurn={changes?.onReviewTurn ?? (() => undefined)}
        onRewindTurn={changes?.onRewindTurn}
        onAnswerPermission={agent.turn.answerPermission}
        onPickModel={agent.setModel}
        onQuote={onQuote}
        className="min-h-0 flex-1"
      />
      <AgentComposer
        agent={agent}
        changedFiles={changedFiles}
        placeholder={`Ask the agent about ${worktree.branch ?? worktree.name}`}
        latestChanges={changes?.latestChanges}
        quote={quote}
        onQuoteStaged={onQuoteStaged}
        context={model.context}
      />
    </div>
  )
}
