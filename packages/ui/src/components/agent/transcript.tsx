import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, Copy, FileDiff, FileText, Globe, Info, Pencil, Puzzle, Search, Terminal, Users, Wrench } from 'lucide-react'

import type { PermissionDecisionInput, TurnImage } from '@canopy/shared'
import { isHarnessText } from '@canopy/shared'
import type { AgentEvent, DeltaBuffers, SessionInfo, ToolKind, Transcript as FoldedTranscript, Turn } from '@canopy/shared/agent-stream'
import { AgentEventType, isEvent, previewOf, toolKind, toolTitle, toolVerb } from '@canopy/shared/agent-stream'

import { AgentActivity, AgentActivityCard, AgentActivityContent, AgentActivityCue, AgentActivityTrigger } from '@/components/ui/agent-activity'
import { AgentDetails, AgentDetailsField, AgentDetailsProject, AgentDetailsSection } from '@/components/ui/agent-details'
import { Button } from '@/components/ui/button'
import { ConversationRail, ConversationRailItem, ConversationRailPreview, ConversationRailTrigger } from '@/components/ui/conversation-rail'
import { Message, MessageAction, MessageActions, MessageBubble, MessageContent } from '@/components/ui/message'
import { MessageMarkdown } from '@/components/ui/message-markdown'
import { MessageScroller, MessageScrollerContent, MessageScrollerViewport } from '@/components/ui/message-scroller'
import { RandomAvatar } from '@/components/ui/random-avatar'
import { Sheet, SheetAction, SheetBody, SheetExpand, SheetHandle, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import {
  ToolApproval,
  ToolApprovalAction,
  ToolApprovalActions,
  ToolApprovalCommand,
  ToolApprovalDescription,
  ToolApprovalHeader,
  ToolApprovalHeading,
  ToolApprovalIcon,
  ToolApprovalTitle,
  type ToolApprovalResolution
} from '@/components/ui/tool-approval'
import { ToolCall, ToolCallContent, ToolCallTabs, ToolCallTrigger } from '@/components/ui/tool-call'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TranscriptDivider } from '@/components/ui/transcript-divider'
import { plural } from '@/lib/format'
import { beatLabel, beatsOf, type ActivityBeat, type Beat, type BeatCall } from '@/lib/turn-beats'
import { rowsByTurn } from '@/lib/turn-rows'
import { cn } from '@/lib/utils'

import type { Activity } from './agent-avatar'
import type { PendingPrompt } from '../../lib/use-agent-turn'
import { TurnStatus } from './turn-status'
import { ImageTiles, ImageViewer, TextWithImageRefs } from './image-strip'
import { SelectionActions } from './selection-actions'

const TOOL_ICON: Record<ToolKind, React.ReactNode> = {
  shell: <Terminal />,
  file_read: <FileText />,
  file_edit: <Pencil />,
  search: <Search />,
  web: <Globe />,
  plan: <FileText />,
  subagent: <Users />,
  workflow: <Users />,
  mcp: <Puzzle />,
  other: <Wrench />
}

/** How much of a tool's output the details sheet shows; the rest is scrollback nobody reads here. */
const OUTPUT_CAP = 8000

const prettyInput = (input: unknown): string => {
  try {
    return typeof input === 'string' ? input : JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

/** Which details the sheet is showing. Keys, not objects: the transcript is rebuilt per event and the sheet must follow. */
type SheetTarget = { kind: 'beat'; key: string } | { kind: 'run'; callId: string } | { kind: 'session' }

/** Puts a message's own text on the clipboard, flipping to a check for a moment as feedback. */
function CopyAction({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copy = (): void => {
    // Clipboard access is absent in insecure contexts and writes can be denied.
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true)
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setCopied(false), 2000)
      })
      .catch(() => {})
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <MessageAction aria-label={copied ? 'Copied' : 'Copy this message'} onClick={copy}>
          {copied ? <Check /> : <Copy />}
        </MessageAction>
      </TooltipTrigger>
      <TooltipContent>{copied ? 'Copied' : 'Copy this message'}</TooltipContent>
    </Tooltip>
  )
}

/** A user turn: image previews, the typed text (image refs clickable), and on hover the files it changed. */
function UserTurn({ text, images, files, turnKey, onReviewTurn }: {
  text: string
  images: TurnImage[]
  files?: string[]
  turnKey: string
  onReviewTurn: (key: string) => void
}): React.JSX.Element {
  const [viewer, setViewer] = useState<number | null>(null)
  return (
    <Message from="user">
      <MessageContent>
        {images.length > 0 ? <ImageTiles images={images} onOpen={setViewer} /> : null}
        {text ? (
          <MessageBubble variant="primary">
            <TextWithImageRefs text={text} images={images} onOpen={setViewer} />
          </MessageBubble>
        ) : null}
        {text || files?.length ? (
          <MessageActions className="self-end">
            {files?.length ? (
              <>
                <span>{plural(files.length, 'file')} changed</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <MessageAction aria-label={`Show the ${plural(files.length, 'file')} this turn changed`} onClick={() => onReviewTurn(turnKey)}>
                      <FileDiff />
                    </MessageAction>
                  </TooltipTrigger>
                  <TooltipContent>Show code changes</TooltipContent>
                </Tooltip>
              </>
            ) : null}
            {text ? <CopyAction text={text} /> : null}
          </MessageActions>
        ) : null}
        {images.length > 0 ? <ImageViewer images={images} index={viewer} onClose={() => setViewer(null)} /> : null}
      </MessageContent>
    </Message>
  )
}

/** An agent bubble; `streaming` marks text still arriving. */
function AssistantTurn({ text, avatarSeed, streaming }: { text: string; avatarSeed: string; streaming?: boolean }): React.JSX.Element {
  return (
    <Message from="assistant">
      <RandomAvatar seed={avatarSeed} name="Agent" className="size-8 shrink-0 self-end rounded-full" />
      <MessageContent>
        <MessageBubble variant="muted" className="min-w-0 max-w-full overflow-hidden [&_pre]:max-w-full [&_pre]:overflow-x-auto">
          <MessageMarkdown className="text-sm" streaming={streaming}>{text}</MessageMarkdown>
        </MessageBubble>
        {/* Copying half-arrived text would hand over a truncated answer, so the action waits for the end. */}
        {streaming ? null : (
          <MessageActions>
            <CopyAction text={text} />
          </MessageActions>
        )}
      </MessageContent>
    </Message>
  )
}

/** What a delegated run is up to, in one line. */
function runMeta(call: BeatCall): string {
  const run = call.run
  if (!run) return call.status === 'running' ? 'Starting…' : 'Done'
  if (run.done) {
    const steps = run.events.filter((event) => isEvent(event, AgentEventType.ToolCallStarted)).length
    return steps > 0 ? `Done · ${plural(steps, 'step')}` : 'Done'
  }
  return run.status ?? (run.lastTool ? `Working · ${run.lastTool}` : 'Working…')
}

/**
 * One beat of agent work as the transcript shows it: a quiet cue for the tools it ran itself and a
 * card per run it delegated. Nothing expands in place — each opens the details sheet.
 */
function ActivityRow({ beat, avatarSeed, open, sheetId, onOpen }: {
  beat: ActivityBeat
  avatarSeed: string
  open: SheetTarget | null
  sheetId: string
  onOpen: (target: SheetTarget) => void
}): React.JSX.Element {
  const cueOpen = open?.kind === 'beat' && open.key === beat.key
  const hasCue = beat.calls.length > 0 || beat.thoughts.length > 0
  return (
    <div className="ml-10 flex max-w-[92%] flex-col items-start gap-1.5">
      {hasCue ? (
        <AgentActivity status={beat.status}>
          <AgentActivityTrigger
            icon={<RandomAvatar seed={avatarSeed} name="Agent" busy={beat.status === 'running'} className="size-4" />}
            aria-expanded={cueOpen}
            aria-controls={cueOpen ? sheetId : undefined}
            onClick={() => onOpen({ kind: 'beat', key: beat.key })}
          >
            {beatLabel(beat)}
          </AgentActivityTrigger>
        </AgentActivity>
      ) : null}
      {beat.runs.map((call) => {
        const cardOpen = open?.kind === 'run' && open.callId === call.callId
        const busy = call.run ? !call.run.done : call.status === 'running'
        return (
          <AgentActivityCard
            key={call.callId}
            icon={<RandomAvatar seed={call.callId} name={call.run?.label ?? call.title} busy={busy} className="size-7" />}
            title={call.run?.label ?? call.run?.description ?? call.title}
            meta={runMeta(call)}
            aria-haspopup="dialog"
            aria-expanded={cardOpen}
            aria-controls={cardOpen ? sheetId : undefined}
            onClick={() => onOpen({ kind: 'run', callId: call.callId })}
          />
        )
      })}
    </div>
  )
}

/** One tool call in the details sheet: what it was asked and what it answered. */
function CallRow({ call }: { call: BeatCall }): React.JSX.Element {
  const running = call.status === 'running'
  const output = call.result ? call.result.text.slice(0, OUTPUT_CAP) : call.abandoned ? 'No result: the turn ended first.' : undefined
  return (
    <ToolCall status={call.status} className="w-full">
      <ToolCallTrigger icon={TOOL_ICON[call.kind]} meta={call.title}>
        {toolVerb(call.name, running)}
      </ToolCallTrigger>
      <ToolCallContent>
        <ToolCallTabs input={prettyInput(call.input)} output={output} defaultTab={output === undefined ? 'input' : 'output'} />
      </ToolCallContent>
    </ToolCall>
  )
}

/** The thinking and tool calls behind one cue. */
function BeatSheetBody({ beat }: { beat: ActivityBeat }): React.JSX.Element {
  return (
    <>
      {beat.thoughts.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <AgentActivityCue>Thought</AgentActivityCue>
          {beat.thoughts.map((thought) =>
            isEvent(thought, AgentEventType.Reasoning) ? (
              <p key={thought.id} className="m-0 whitespace-pre-wrap font-sans nessa-text-4 text-foreground">
                {thought.payload.text}
              </p>
            ) : null
          )}
        </div>
      ) : null}
      {beat.calls.length > 0 ? (
        <AgentActivityContent className="w-full">
          {beat.calls.map((call) => (
            <CallRow key={call.callId} call={call} />
          ))}
        </AgentActivityContent>
      ) : null}
    </>
  )
}

/** A delegated run: what it was told, what it did, and what it reported back. */
function RunSheetBody({ call, transcript }: { call: BeatCall; transcript: FoldedTranscript }): React.JSX.Element {
  const run = call.run
  const brief = run?.description ?? call.title
  const report = transcript.resultByCallId.get(call.callId)?.text
  const steps = (run?.events ?? []).filter((event) => isEvent(event, AgentEventType.ToolCallStarted))
  const said = (run?.events ?? []).filter((event) => isEvent(event, AgentEventType.AssistantText))
  return (
    <>
      <p className="m-0 font-sans nessa-text-4 text-foreground">{brief}</p>
      {steps.length > 0 ? (
        <AgentActivityContent className="w-full">
          {steps.map((event) => {
            if (!isEvent(event, AgentEventType.ToolCallStarted)) return null
            const answered = transcript.resultByCallId.has(event.payload.callId)
            const running = !answered && !run?.done
            return (
              <ToolCall key={event.id} status={answered ? 'complete' : running ? 'running' : 'error'} className="w-full">
                <ToolCallTrigger icon={TOOL_ICON[event.payload.kind]} meta={event.payload.title}>
                  {toolVerb(event.payload.name, running)}
                </ToolCallTrigger>
                <ToolCallContent>
                  <ToolCallTabs input={prettyInput(event.payload.input)} output={transcript.resultByCallId.get(event.payload.callId)?.text.slice(0, OUTPUT_CAP)} />
                </ToolCallContent>
              </ToolCall>
            )
          })}
        </AgentActivityContent>
      ) : run && !run.done ? (
        <p className="m-0 nessa-text-2 text-muted-foreground">This run has reported nothing yet.</p>
      ) : null}
      {said.map((event) =>
        isEvent(event, AgentEventType.AssistantText) && event.payload.text.trim() ? (
          <MessageMarkdown key={event.id} className="text-xs">
            {event.payload.text}
          </MessageMarkdown>
        ) : null
      )}
      {report?.trim() ? (
        <div className="w-full border-t border-border pt-3">
          <p className="mb-1 nessa-text-1 uppercase text-muted-foreground">Reported back</p>
          <MessageMarkdown className="text-xs">{report}</MessageMarkdown>
        </div>
      ) : null}
    </>
  )
}

/** The session's identity, for the details sheet. */
function SessionSheetBody({ session, openInTerminal }: { session: SessionInfo | null; openInTerminal?: boolean }): React.JSX.Element {
  return (
    <>
      <AgentDetails title={session?.model ?? 'Agent session'}>
        {session?.cwd ? <AgentDetailsProject path={session.cwd} branch={undefined} /> : null}
        <AgentDetailsSection title="Session">
          {session?.model ? <AgentDetailsField label="Model" value={session.model} /> : null}
          {session?.permissionMode ? <AgentDetailsField label="Mode" value={session.permissionMode} /> : null}
          {session?.version ? <AgentDetailsField label="Version" value={session.version} /> : null}
          {session ? <AgentDetailsField label="Tools" value={String(session.tools.length)} /> : null}
        </AgentDetailsSection>
      </AgentDetails>
      {openInTerminal ? (
        <p className="m-0 rounded-lg border border-border bg-muted/40 px-3 py-2 nessa-text-2 text-muted-foreground">
          A terminal has this session open. Turns sent from here run against it, but that terminal will not show them until it resumes.
        </p>
      ) : null}
    </>
  )
}

/** One line naming the session, with the way into its details. */
function SessionLine({ session, openInTerminal, open, sheetId, onOpen }: {
  session: SessionInfo | null
  openInTerminal?: boolean
  open: SheetTarget | null
  sheetId: string
  onOpen: (target: SheetTarget) => void
}): React.JSX.Element | null {
  if (!session && !openInTerminal) return null
  const isOpen = open?.kind === 'session'
  const where = session?.cwd ? session.cwd.split('/').filter(Boolean).at(-1) : null
  return (
    <div className="mb-1 flex items-center gap-1 nessa-text-2 text-muted-foreground">
      <span className="min-w-0 truncate">
        {[session?.model, where].filter(Boolean).join(' · ') || 'Agent session'}
        {openInTerminal ? ' · open in a terminal' : ''}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 shrink-0 text-muted-foreground"
        aria-label="Session details"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={isOpen ? sheetId : undefined}
        onClick={() => onOpen({ kind: 'session' })}
      >
        <Info className="size-3.5" />
      </Button>
    </div>
  )
}

/** A tool the agent wants to run and may not without the user. Answered once; the card then goes inert until its event lands. */
function AskCard({ ask, onAnswer }: { ask: AgentEvent; onAnswer: (input: PermissionDecisionInput) => void }): React.JSX.Element | null {
  const [resolution, setResolution] = useState<ToolApprovalResolution | null>(null)
  if (!isEvent(ask, AgentEventType.PermissionRequested)) return null
  const { requestId, toolName, input, displayName, description, reason } = ask.payload
  const kind = toolKind(toolName)
  const name = displayName ?? toolName
  const what = toolTitle(toolName, input)
  const why = description ?? (reason === 'rule' ? 'A permission rule asks first.' : reason === 'mode' ? 'The access mode asks first.' : `${name} needs your approval.`)
  const decide = (behavior: 'allow' | 'deny'): void => {
    setResolution(behavior === 'allow' ? 'allowed' : 'denied')
    onAnswer(behavior === 'allow' ? { requestId, behavior } : { requestId, behavior, message: `The user declined this ${toolName} call.` })
  }
  return (
    <ToolApproval variant="docked" resolution={resolution} aria-label={`Allow ${name}?`} className="ml-10 max-w-[92%]">
      <ToolApprovalHeader>
        <ToolApprovalIcon>{TOOL_ICON[kind]}</ToolApprovalIcon>
        <ToolApprovalHeading>
          <ToolApprovalTitle>{what && what !== name ? `${name} · ${what}` : name}</ToolApprovalTitle>
          <ToolApprovalDescription>{why}</ToolApprovalDescription>
        </ToolApprovalHeading>
      </ToolApprovalHeader>
      <ToolApprovalCommand json={input} label={`${toolName} input`} />
      <ToolApprovalActions>
        <ToolApprovalAction variant="default" onClick={() => decide('allow')} disabled={resolution !== null}>
          Allow
        </ToolApprovalAction>
        <ToolApprovalAction variant="ghost" onClick={() => decide('deny')} disabled={resolution !== null}>
          Deny
        </ToolApprovalAction>
      </ToolApprovalActions>
    </ToolApproval>
  )
}

function BeatRow({ beat, avatarSeed, previews, open, sheetId, onOpen }: {
  beat: Beat
  avatarSeed: string
  previews: DeltaBuffers
  open: SheetTarget | null
  sheetId: string
  onOpen: (target: SheetTarget) => void
}): React.JSX.Element | null {
  switch (beat.kind) {
    case 'activity':
      return <ActivityRow beat={beat} avatarSeed={avatarSeed} open={open} sheetId={sheetId} onOpen={onOpen} />
    case 'text': {
      if (!isEvent(beat.event, AgentEventType.AssistantText)) return null
      // The committed text wins; the delta buffer only stands in while a block is still arriving.
      const text = beat.event.payload.text || previewOf(previews, beat.event.payload.block) || ''
      return text ? <AssistantTurn text={text} avatarSeed={avatarSeed} /> : null
    }
    case 'user':
      if (!isEvent(beat.event, AgentEventType.UserMessage) || isHarnessText(beat.event.payload.text)) return null
      return <UserTurn text={beat.event.payload.text} images={[]} turnKey={beat.key} onReviewTurn={() => {}} />
    case 'note':
      return <p className={cn('m-0 ml-10 nessa-text-2', beat.tone === 'error' ? 'text-destructive' : 'text-muted-foreground')}>{beat.text}</p>
    case 'compacted': {
      const payload = isEvent(beat.event, AgentEventType.ContextCompacted) ? beat.event.payload : null
      const size = payload && payload.preTokens !== null && payload.postTokens !== null ? `${Math.round(payload.preTokens / 1000)}k → ${Math.round(payload.postTokens / 1000)}k tokens` : undefined
      return <TranscriptDivider meta={size}>{payload?.trigger === 'manual' ? 'Context compacted on request' : 'Context compacted'}</TranscriptDivider>
    }
  }
}

export function TranscriptView({
  transcript,
  previews,
  extras,
  pending,
  streamingText,
  activity,
  startedAt,
  tokens,
  avatarSeed,
  emptyMessage,
  filesByTurn,
  openInTerminal,
  onReviewTurn,
  onAnswerPermission,
  onQuote,
  className
}: {
  transcript: FoldedTranscript
  previews: DeltaBuffers
  /** Images by user-message event id. */
  extras: Record<string, { images: TurnImage[] }>
  /** The just-sent prompt, shown until its echo arrives. */
  pending: PendingPrompt | null
  streamingText: string
  activity: Activity | null
  startedAt: number | null
  tokens: number
  avatarSeed: string
  emptyMessage: React.ReactNode
  /** Files each turn wrote, by turn key. */
  filesByTurn: ReadonlyMap<string, string[]>
  openInTerminal?: boolean
  onReviewTurn: (turnKey: string) => void
  /** Answers a tool-permission ask of the running turn. */
  onAnswerPermission?: (input: PermissionDecisionInput) => void
  /** Stages transcript text the reader selected as context on the composer. */
  onQuote?: (text: string) => void
  className?: string
}): React.JSX.Element {
  const turns = transcript.turns
  const railTurns = turns.filter(
    (turn): turn is Turn & { prompt: AgentEvent } => turn.prompt !== null && isEvent(turn.prompt, AgentEventType.UserMessage) && !turn.prompt.payload.synthetic && !isHarnessText(turn.prompt.payload.text)
  )
  const [activeTurn, setActiveTurn] = useState<string>()
  const [sheet, setSheet] = useState<SheetTarget | null>(null)
  const sheetId = useId()
  const rowRefs = useRef(new Map<string, HTMLElement>())
  // Only text inside the conversation itself gets the selection popover.
  const conversation = useRef<HTMLDivElement>(null)
  // Each turn's beats, with the closing text the fold lifted into `finalText` put back in place.
  const beatsByTurn = useMemo(() => {
    const rows = rowsByTurn(transcript)
    return new Map(turns.map((turn) => [turn.key, beatsOf(rows.get(turn.key) ?? turn.work, transcript)] as const))
  }, [transcript, turns])
  const beatIndex = useMemo(() => {
    const beats = new Map<string, ActivityBeat>()
    const runs = new Map<string, BeatCall>()
    for (const list of beatsByTurn.values()) {
      for (const beat of list) {
        if (beat.kind !== 'activity') continue
        beats.set(beat.key, beat)
        for (const call of beat.runs) runs.set(call.callId, call)
      }
    }
    return { beats, runs }
  }, [beatsByTurn])
  const empty = turns.length === 0 && !pending && !streamingText
  // Asks only matter while a turn is running here; a replayed one nobody answered is just history.
  const asks = startedAt !== null && onAnswerPermission ? transcript.pendingAsks.filter((ask) => ask.agentPath.length === 0) : []
  const jumpTo = (key: string): void => {
    setActiveTurn(key)
    rowRefs.current.get(key)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const promptText = (turn: Turn): string =>
    turn.prompt && isEvent(turn.prompt, AgentEventType.UserMessage) ? turn.prompt.payload.text : ''

  const shown = sheet?.kind === 'beat' ? beatIndex.beats.get(sheet.key) : undefined
  const shownRun = sheet?.kind === 'run' ? beatIndex.runs.get(sheet.callId) : undefined
  const sheetTitle = sheet?.kind === 'session' ? 'Session' : shown ? beatLabel(shown) : shownRun ? (shownRun.run?.label ?? shownRun.title) : null

  return (
    <div className={cn('flex min-h-0 gap-1', className)}>
      {railTurns.length > 1 ? (
        <ConversationRail aria-label="Jump to a turn" className="shrink-0 self-center">
          {railTurns.map((turn) => (
            <ConversationRailItem key={turn.key} active={turn.key === activeTurn}>
              <ConversationRailTrigger aria-label={promptText(turn).slice(0, 80)} onClick={() => jumpTo(turn.key)} />
              <ConversationRailPreview className="max-w-xs">
                <p className="m-0 line-clamp-3 text-xs text-foreground">{promptText(turn)}</p>
              </ConversationRailPreview>
            </ConversationRailItem>
          ))}
        </ConversationRail>
      ) : null}
      {/* The details sheet rises over this frame, so the composer beside it stays reachable. */}
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <MessageScroller className="min-h-0 min-w-0 flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent ref={conversation} aria-label="Agent conversation" className="max-w-full overflow-x-hidden">
              <SessionLine session={transcript.session} openInTerminal={openInTerminal} open={sheet} sheetId={sheetId} onOpen={setSheet} />
              {empty ? <div className="rounded-xl border border-border py-10 text-center text-sm text-muted-foreground">{emptyMessage}</div> : null}
              {turns.map((turn) => {
                const prompt = turn.prompt && isEvent(turn.prompt, AgentEventType.UserMessage) && !turn.prompt.payload.synthetic && !isHarnessText(turn.prompt.payload.text) ? turn.prompt : null
                return (
                  <div
                    key={turn.key}
                    ref={(el) => {
                      if (el) rowRefs.current.set(turn.key, el)
                      else rowRefs.current.delete(turn.key)
                    }}
                    className="flex scroll-mt-2 flex-col gap-2"
                  >
                    {prompt ? (
                      <UserTurn
                        text={prompt.payload.text}
                        images={extras[prompt.id]?.images ?? []}
                        files={filesByTurn.get(turn.key)}
                        turnKey={turn.key}
                        onReviewTurn={onReviewTurn}
                      />
                    ) : null}
                    {(beatsByTurn.get(turn.key) ?? []).map((beat) => (
                      <BeatRow key={beat.key} beat={beat} avatarSeed={avatarSeed} previews={previews} open={sheet} sheetId={sheetId} onOpen={setSheet} />
                    ))}
                  </div>
                )
              })}
              {pending ? <UserTurn text={pending.display.trim()} images={pending.images} turnKey="pending" onReviewTurn={() => {}} /> : null}
              {onAnswerPermission ? asks.map((ask) => <AskCard key={ask.id} ask={ask} onAnswer={onAnswerPermission} />) : null}
              {activity && startedAt !== null && !streamingText && asks.length === 0 ? <TurnStatus activity={activity} startedAt={startedAt} tokens={tokens} avatarSeed={avatarSeed} /> : null}
              {streamingText ? <AssistantTurn text={streamingText} avatarSeed={avatarSeed} streaming /> : null}
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
        <SelectionActions host={conversation} onAsk={onQuote} />
        {sheet && sheetTitle !== null ? (
          <Sheet id={sheetId} label={sheetTitle} modal={false} onClose={() => setSheet(null)}>
            <SheetHandle />
            <SheetHeader>
              <SheetExpand />
              <SheetTitle>{sheetTitle}</SheetTitle>
              <SheetAction>Done</SheetAction>
            </SheetHeader>
            <SheetBody>
              {sheet.kind === 'session' ? <SessionSheetBody session={transcript.session} openInTerminal={openInTerminal} /> : null}
              {shown ? <BeatSheetBody beat={shown} /> : null}
              {shownRun ? <RunSheetBody call={shownRun} transcript={transcript} /> : null}
            </SheetBody>
          </Sheet>
        ) : null}
      </div>
    </div>
  )
}
