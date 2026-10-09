import type { ChangedFile, SessionOrigin, Worktree } from '@canopy/shared'

import { ErrorNote } from '@/components/error-note'
import type { Staging } from '@/lib/use-staging'
import type { TranscriptModel } from '@/lib/use-transcript-model'
import type { WorktreeAgent } from '@/lib/use-worktree-agent'

import { AgentAvatar } from './agent-avatar'
import { AgentComposer } from './composer'
import { FileRefLinks, type OpenFileRef } from './answer-links'
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

/** A ready-made first message: `label` is what the starter and the transcript show, `prompt` what the agent receives. */
export interface PromptSuggestion {
  id: string
  label: string
  prompt: string
  /** One line under the label. */
  hint?: string
  icon?: React.ReactNode
}

/** What an empty conversation opens on instead of the plain note: a title, a line, and first messages to pick from. */
export interface Starter {
  title: string
  /** The line under the title; the conversation's own empty note when absent. */
  note?: string
  suggestions: PromptSuggestion[]
}

/**
 * An empty conversation's welcome, in the Git Agent's own look: the agent, what it is for, and
 * the first messages worth sending — each a row with its icon and what it gives back.
 */
function StarterView({ agent, seed, note, starter }: { agent: WorktreeAgent; seed: string; note: string; starter: Starter }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-3 px-4 pt-10 pb-6 text-center">
      <AgentAvatar seed={seed} className="size-12" />
      <p className="text-sm font-semibold">{starter.title}</p>
      <p className="max-w-72 text-xs text-muted-foreground">{note}</p>
      <div className="mt-3 grid w-full max-w-2xl gap-2 text-left [grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))]">
        {starter.suggestions.map(({ id, label, prompt, hint, icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => void agent.turn.sendMessage(prompt, { display: label, attachments: [], images: [] })}
            className="group flex items-start gap-3 rounded-lg text-left border border-border bg-card/60 px-3 py-2.5 transition-colors outline-none hover:border-foreground/20 hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/40"
          >
            {icon ? <span className="mt-0.5 shrink-0">{icon}</span> : null}
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-xs font-medium text-foreground">{label}</span>
              {hint ? <span className="text-[11px] leading-snug text-muted-foreground">{hint}</span> : null}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
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
  staging,
  avatarSeed,
  onOpenRef,
  starter
}: {
  worktree: Worktree
  agent: WorktreeAgent
  model: TranscriptModel
  changedFiles: ChangedFile[]
  changes?: TurnChangesWiring
  /** Where quotes from the transcript go, and what the composer stages from; absent, there is no quoting. */
  staging?: Staging
  /** The agent's painted identity; by default its session's, so each conversation looks like itself. */
  avatarSeed?: string
  /** Opens a file reference the agent cited; given, references in its answers become links. */
  onOpenRef?: OpenFileRef
  /** What the conversation opens on while it is empty and ready to send. */
  starter?: Starter
}): React.JSX.Element {
  return (
    <FileRefLinks onOpen={onOpenRef}>
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
          avatarSeed={avatarSeed ?? agent.selected?.sessionId ?? worktree.id}
          capabilities={agent.capabilities}
          emptyMessage={emptyMessage(agent, worktree)}
          emptyState={
            starter && (agent.fresh || agent.selected) && !agent.turn.busy ? (
              <StarterView agent={agent} seed={avatarSeed ?? agent.selected?.sessionId ?? worktree.id} note={starter.note ?? emptyMessage(agent, worktree)} starter={starter} />
            ) : undefined
          }
          writesByTurn={changes?.writesByTurn ?? NO_WRITES}
          openInTerminal={agent.history.data?.openInTerminal}
          onReviewTurn={changes?.onReviewTurn ?? (() => undefined)}
          onRewindTurn={changes?.onRewindTurn}
          onAnswerPermission={agent.turn.answerPermission}
          onPickModel={agent.setModel}
          onQuote={staging ? (text) => staging.stage({ text }) : undefined}
          className="min-h-0 flex-1"
        />
        <AgentComposer
          agent={agent}
          changedFiles={changedFiles}
          placeholder={`Ask the agent about ${worktree.branch ?? worktree.name}`}
          latestChanges={changes?.latestChanges}
          staged={staging?.staged}
          onStaged={staging?.taken}
          context={model.context}
        />
      </div>
    </FileRefLinks>
  )
}
