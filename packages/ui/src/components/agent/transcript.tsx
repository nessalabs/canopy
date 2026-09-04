import { useRef, useState } from 'react'
import { FileDiff, FileText, Globe, Pencil, Puzzle, Search, Terminal, Users, Wrench } from 'lucide-react'

import type { TurnImage } from '@canopy/shared'
import type { AgentEvent, DeltaBuffers, ToolKind, Transcript as FoldedTranscript, Turn, WorkItem } from '@canopy/shared/agent-stream'
import { AgentEventType, isEvent, isToolGroup, previewOf, toolTitle, toolVerb } from '@canopy/shared/agent-stream'

import { AgentActivity, AgentActivityContent, AgentActivityTrigger, formatAgentActivitySummary, type AgentActivityCounts } from '@/components/ui/agent-activity'
import { AgentDetails, AgentDetailsField, AgentDetailsProject, AgentDetailsSection } from '@/components/ui/agent-details'
import { CodeBlock } from '@/components/ui/code-block'
import { ConversationRail, ConversationRailItem, ConversationRailPreview, ConversationRailTrigger } from '@/components/ui/conversation-rail'
import { Message, MessageAction, MessageActions, MessageBubble, MessageContent, MessageFooter } from '@/components/ui/message'
import { MessageMarkdown } from '@/components/ui/message-markdown'
import { MessageScroller, MessageScrollerContent, MessageScrollerViewport } from '@/components/ui/message-scroller'
import { RandomAvatar } from '@/components/ui/random-avatar'
import { ToolCall, ToolCallContent, ToolCallTrigger } from '@/components/ui/tool-call'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { plural } from '@/lib/format'
import { useTheme } from '@/lib/use-theme'
import { cn } from '@/lib/utils'

import type { Activity } from './activity-orb'
import type { PendingPrompt } from '../../lib/use-agent-turn'
import { TurnStatus } from './turn-status'
import { ImageTiles, ImageViewer, TextWithImageRefs } from './image-strip'

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

const prettyInput = (input: unknown): string => {
  try {
    return typeof input === 'string' ? input : JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

/** A collapsible row whose body is highlighted text — reused for reasoning and tool detail. */
function Disclosure({ icon, label, meta, body, status, language = 'text', className = 'ml-10' }: {
  icon: React.ReactNode
  label: string
  meta?: string
  body: string
  status?: 'running' | 'complete' | 'error'
  language?: string
  className?: string
}): React.JSX.Element {
  const { theme } = useTheme()
  return (
    <ToolCall status={status} className={className}>
      <ToolCallTrigger icon={icon} meta={(meta ?? body.split('\n')[0] ?? '').slice(0, 100)}>
        {label}
      </ToolCallTrigger>
      <ToolCallContent>
        <CodeBlock code={body} language={language} mode={theme} wrap className="max-h-80 w-full overflow-auto text-xs" />
      </ToolCallContent>
    </ToolCall>
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
        {files?.length ? (
          <MessageActions className="self-end">
            <span>{plural(files.length, 'file')} changed</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <MessageAction aria-label={`Show the ${plural(files.length, 'file')} this turn changed`} onClick={() => onReviewTurn(turnKey)}>
                  <FileDiff />
                </MessageAction>
              </TooltipTrigger>
              <TooltipContent>Show code changes</TooltipContent>
            </Tooltip>
          </MessageActions>
        ) : null}
        {images.length > 0 ? <ImageViewer images={images} index={viewer} onClose={() => setViewer(null)} /> : null}
      </MessageContent>
    </Message>
  )
}

/** An agent bubble; `caption` marks summarized thinking, `streaming` marks text still arriving. */
function AssistantTurn({ text, avatarSeed, caption, streaming }: { text: string; avatarSeed: string; caption?: string; streaming?: boolean }): React.JSX.Element {
  return (
    <Message from="assistant">
      <RandomAvatar seed={avatarSeed} name="Agent" className="size-8 shrink-0 self-end rounded-full" />
      <MessageContent>
        <MessageBubble variant="muted" className="min-w-0 max-w-full overflow-hidden [&_pre]:max-w-full [&_pre]:overflow-x-auto">
          <MessageMarkdown className="text-sm" streaming={streaming}>{text}</MessageMarkdown>
        </MessageBubble>
        {caption ? <MessageFooter>{caption}</MessageFooter> : null}
      </MessageContent>
    </Message>
  )
}

/** A collapsed run of same-tool calls, as one quiet activity cue that lists what it did. */
function ToolGroupRow({ group }: { group: Extract<WorkItem, { kind: 'tool_group' }> }): React.JSX.Element {
  const counts: AgentActivityCounts = { files: 0, searches: 0, other: 0 }
  for (const call of group.calls) {
    if (!isEvent(call, AgentEventType.ToolCallStarted)) continue
    if (call.payload.kind === 'file_read' || call.payload.kind === 'file_edit') counts.files = (counts.files ?? 0) + 1
    else if (call.payload.kind === 'search') counts.searches = (counts.searches ?? 0) + 1
    else counts.other = (counts.other ?? 0) + 1
  }
  return (
    <AgentActivity status="complete" className="ml-10">
      <AgentActivityTrigger icon={TOOL_ICON[group.calls[0] && isEvent(group.calls[0], AgentEventType.ToolCallStarted) ? group.calls[0].payload.kind : 'other']}>
        {group.target ?? formatAgentActivitySummary(counts)}
      </AgentActivityTrigger>
      <AgentActivityContent>
        <ul className="m-0 list-none space-y-1 p-0 text-xs text-muted-foreground">
          {group.calls.map((call) =>
            isEvent(call, AgentEventType.ToolCallStarted) ? <li key={call.id} className="truncate">{call.payload.title}</li> : null
          )}
        </ul>
      </AgentActivityContent>
    </AgentActivity>
  )
}

/** One tool call: status from its result, body = its input and what it returned. */
function ToolRow({ call, transcript }: { call: AgentEvent; transcript: FoldedTranscript }): React.JSX.Element | null {
  if (!isEvent(call, AgentEventType.ToolCallStarted)) return null
  const { callId, name, kind, input, title } = call.payload
  const result = transcript.resultByCallId.get(callId)
  const abandoned = transcript.abandonedCallIds.has(callId)
  const status = result === undefined ? (abandoned ? 'error' : 'running') : result.isError ? 'error' : 'complete'
  const running = result === undefined && !abandoned
  const body = [prettyInput(input), result ? `\n${result.text.slice(0, 4000)}` : abandoned ? '\nNo result — the turn ended first.' : '']
    .filter(Boolean)
    .join('\n')
  return <Disclosure icon={TOOL_ICON[kind]} label={`${toolVerb(name, running)} ${title}`.trim()} meta={title} body={body} status={status} />
}

/** One work item of a turn → a row (or nothing, for the things drawn elsewhere). */
function WorkRow({ item, transcript, previews, avatarSeed }: { item: WorkItem; transcript: FoldedTranscript; previews: DeltaBuffers; avatarSeed: string }): React.JSX.Element | null {
  if (isToolGroup(item)) return item.calls.length >= 2 ? <ToolGroupRow group={item} /> : <ToolRow call={item.calls[0] as AgentEvent} transcript={transcript} />
  if (isEvent(item, AgentEventType.ToolCallStarted)) return <ToolRow call={item} transcript={transcript} />
  if (isEvent(item, AgentEventType.Reasoning)) return item.payload.text ? <AssistantTurn text={item.payload.text} avatarSeed={avatarSeed} caption="summarized" /> : null
  if (isEvent(item, AgentEventType.AssistantText)) {
    const text = previewOf(previews, item.payload.block) ?? item.payload.text
    return text ? <AssistantTurn text={text} avatarSeed={avatarSeed} /> : null
  }
  if (isEvent(item, AgentEventType.UserMessage)) return item.payload.synthetic ? null : <UserTurn text={item.payload.text} images={[]} turnKey={item.id} onReviewTurn={() => {}} />
  if (isEvent(item, AgentEventType.Error)) return <p className="ml-10 text-xs text-destructive">{item.payload.message}</p>
  if (isEvent(item, AgentEventType.ContextCompacted)) return <div className="my-2 text-center text-[11px] uppercase tracking-wide text-muted-foreground">Context compacted</div>
  return null
}

/** The session's identity: model, working directory, permission mode, CLI version. */
function SessionHeader({ transcript, openInTerminal }: { transcript: FoldedTranscript; openInTerminal?: boolean }): React.JSX.Element | null {
  const session = transcript.session
  if (!session && !openInTerminal) return null
  return (
    <div className="mb-1">
      {session ? (
        <AgentDetails title={session.model ?? 'Agent session'}>
          {session.cwd ? <AgentDetailsProject path={session.cwd} branch={undefined} /> : null}
          <AgentDetailsSection title="Session">
            {session.model ? <AgentDetailsField label="Model" value={session.model} /> : null}
            {session.permissionMode ? <AgentDetailsField label="Mode" value={session.permissionMode} /> : null}
            {session.version ? <AgentDetailsField label="Version" value={session.version} /> : null}
          </AgentDetailsSection>
        </AgentDetails>
      ) : null}
      {openInTerminal ? (
        <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          A terminal has this session open. Turns sent from here run against it, but that terminal will not show them until it resumes.
        </p>
      ) : null}
    </div>
  )
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
  className?: string
}): React.JSX.Element {
  const turns = transcript.turns
  const railTurns = turns.filter((turn): turn is Turn & { prompt: AgentEvent } => turn.prompt !== null && isEvent(turn.prompt, AgentEventType.UserMessage) && !turn.prompt.payload.synthetic)
  const [activeTurn, setActiveTurn] = useState<string>()
  const rows = useRef(new Map<string, HTMLElement>())
  const empty = turns.length === 0 && !pending && !streamingText
  const jumpTo = (key: string): void => {
    setActiveTurn(key)
    rows.current.get(key)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const promptText = (turn: Turn): string =>
    turn.prompt && isEvent(turn.prompt, AgentEventType.UserMessage) ? turn.prompt.payload.text : ''

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
      <MessageScroller className="min-h-0 min-w-0 flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent aria-label="Agent conversation" className="max-w-full overflow-x-hidden">
            <SessionHeader transcript={transcript} openInTerminal={openInTerminal} />
            {empty ? <div className="rounded-xl border border-border py-10 text-center text-sm text-muted-foreground">{emptyMessage}</div> : null}
            {turns.map((turn) => {
              const prompt = turn.prompt && isEvent(turn.prompt, AgentEventType.UserMessage) && !turn.prompt.payload.synthetic ? turn.prompt : null
              return (
                <div
                  key={turn.key}
                  ref={(el) => {
                    if (el) rows.current.set(turn.key, el)
                    else rows.current.delete(turn.key)
                  }}
                  className="scroll-mt-2"
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
                  {turn.work.map((item, index) => (
                    <WorkRow key={isToolGroup(item) ? item.key : item.id} item={item} transcript={transcript} previews={previews} avatarSeed={avatarSeed} />
                  ))}
                </div>
              )
            })}
            {pending ? <UserTurn text={pending.display.trim()} images={pending.images} turnKey="pending" onReviewTurn={() => {}} /> : null}
            {activity && startedAt !== null && !streamingText ? <TurnStatus activity={activity} startedAt={startedAt} tokens={tokens} /> : null}
            {streamingText ? <AssistantTurn text={streamingText} avatarSeed={avatarSeed} streaming /> : null}
          </MessageScrollerContent>
        </MessageScrollerViewport>
      </MessageScroller>
    </div>
  )
}
