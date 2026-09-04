import { useRef, useState } from 'react'
import { FileDiff, Paperclip, Wrench } from 'lucide-react'

import type { TranscriptItem, TranscriptRole } from '@canopy/shared'

import { ConversationRail, ConversationRailItem, ConversationRailPreview, ConversationRailTrigger } from '@/components/ui/conversation-rail'
import { CodeBlock } from '@/components/ui/code-block'
import { Message, MessageAction, MessageActions, MessageBubble, MessageContent, MessageFooter } from '@/components/ui/message'
import { MessageMarkdown } from '@/components/ui/message-markdown'
import { MessageScroller, MessageScrollerContent, MessageScrollerViewport } from '@/components/ui/message-scroller'
import { RandomAvatar } from '@/components/ui/random-avatar'
import { ToolCall, ToolCallContent, ToolCallTrigger } from '@/components/ui/tool-call'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { plural } from '@/lib/format'
import { guessLanguage } from '@/lib/language'
import { useTheme } from '@/lib/use-theme'
import { cn } from '@/lib/utils'

import type { Activity } from './activity-orb'
import { TurnStatus } from './turn-status'
import { ImageTiles, ImageViewer, TextWithImageRefs } from './image-strip'

interface RenderProps {
  item: TranscriptItem
  avatarSeed: string
  /** Files the turn starting at this user message wrote; drives the hover action. */
  files?: string[]
  onReviewTurn: (turnId: string) => void
}

/** A collapsible row for tool calls, results, reasoning and attachments; the body is highlighted code. */
function Disclosure({ icon, label, text, meta, language, className = 'ml-10' }: { icon: React.ReactNode; label: string; text: string; meta?: string; language?: string; className?: string }): React.JSX.Element {
  const { theme } = useTheme()
  return (
    <ToolCall className={className}>
      <ToolCallTrigger icon={icon} meta={(meta ?? text.split('\n')[0] ?? '').slice(0, 100)}>
        {label}
      </ToolCallTrigger>
      <ToolCallContent>
        <CodeBlock code={text} language={language ?? 'text'} mode={theme} wrap className="max-h-80 w-full overflow-auto text-xs" />
      </ToolCallContent>
    </ToolCall>
  )
}

/** A user turn: image previews on top, the typed text (image refs clickable), attachment chips, and on hover the files it changed. */
function UserTurn({ item, files, onReviewTurn }: RenderProps): React.JSX.Element {
  const [viewer, setViewer] = useState<number | null>(null)
  const images = item.images ?? []
  const text = (item.display ?? item.text).trim()
  return (
    <Message from="user">
      <MessageContent>
        {images.length > 0 ? <ImageTiles images={images} onOpen={setViewer} /> : null}
        {text ? (
          <MessageBubble variant="primary">
            <TextWithImageRefs text={text} images={images} onOpen={setViewer} />
          </MessageBubble>
        ) : null}
        {item.attachments?.map((attachment, index) => (
          <Disclosure key={index} icon={<Paperclip />} label={attachment.label} text={attachment.text} language={guessLanguage(undefined, attachment.text)} className="self-end" />
        ))}
        {files?.length ? (
          <MessageActions className="self-end">
            <span>{plural(files.length, 'file')} changed</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <MessageAction aria-label={`Show the ${plural(files.length, 'file')} this turn changed`} onClick={() => onReviewTurn(item.id)}>
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

/** One renderer per transcript role; `system` items are bookkeeping and stay hidden. */
const RENDERERS: Record<TranscriptRole, (props: RenderProps) => React.JSX.Element | null> = {
  user: (props) => <UserTurn {...props} />,
  assistant: ({ item, avatarSeed }) => <AssistantTurn text={item.text} avatarSeed={avatarSeed} />,
  // Raw thinking is redacted; what arrives is the model's summary of a step, which Claude Code
  // keeps in the conversation marked "summarized". Same row as a reply, with that mark.
  reasoning: ({ item, avatarSeed }) => <AssistantTurn text={item.text} avatarSeed={avatarSeed} caption="summarized" />,
  tool: ({ item }) => <Disclosure icon={<Wrench />} label={item.tool ?? 'Tool'} meta={item.title} text={item.text} language={guessLanguage(item.tool, item.text)} />,
  system: () => null
}

export function Transcript({
  items,
  streamingText,
  activity,
  startedAt,
  tokens,
  avatarSeed,
  emptyMessage,
  filesByTurn,
  onReviewTurn,
  className
}: {
  items: TranscriptItem[]
  streamingText: string | null
  /** While set and nothing is streaming yet, an orb row stands in for the reply. */
  activity: Activity | null
  startedAt: number | null
  tokens: number
  avatarSeed: string
  emptyMessage: React.ReactNode
  /** Files each user turn wrote, by user item id. */
  filesByTurn: ReadonlyMap<string, string[]>
  onReviewTurn: (turnId: string) => void
  className?: string
}): React.JSX.Element {
  const turns = items.filter((item) => item.role === 'user')
  const [activeTurn, setActiveTurn] = useState<string>()
  const rows = useRef(new Map<string, HTMLElement>())
  const jumpTo = (id: string): void => {
    setActiveTurn(id)
    rows.current.get(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className={cn('flex min-h-0 gap-1', className)}>
      {turns.length > 1 ? (
        <ConversationRail aria-label="Jump to a turn" className="shrink-0 self-center">
          {turns.map((turn) => (
            <ConversationRailItem key={turn.id} active={turn.id === activeTurn}>
              <ConversationRailTrigger aria-label={(turn.display ?? turn.text).slice(0, 80)} onClick={() => jumpTo(turn.id)} />
              <ConversationRailPreview className="max-w-xs">
                <p className="m-0 line-clamp-3 text-xs text-foreground">{turn.display ?? turn.text}</p>
              </ConversationRailPreview>
            </ConversationRailItem>
          ))}
        </ConversationRail>
      ) : null}
    <MessageScroller className="min-h-0 min-w-0 flex-1">
      <MessageScrollerViewport>
        <MessageScrollerContent aria-label="Agent conversation" className="max-w-full overflow-x-hidden">
          {items.length === 0 && !streamingText ? (
            <div className="rounded-xl border border-border py-10 text-center text-sm text-muted-foreground">{emptyMessage}</div>
          ) : null}
          {items.map((item) => {
            const Render = RENDERERS[item.role]
            return (
              <div key={item.id} ref={(el) => {
                  if (el) rows.current.set(item.id, el)
                  else rows.current.delete(item.id)
                }} className="scroll-mt-2">
                <Render item={item} avatarSeed={avatarSeed} files={filesByTurn.get(item.id)} onReviewTurn={onReviewTurn} />
              </div>
            )
          })}
          {activity && startedAt !== null && !streamingText ? <TurnStatus activity={activity} startedAt={startedAt} tokens={tokens} /> : null}
          {streamingText ? <AssistantTurn text={streamingText} avatarSeed={avatarSeed} streaming /> : null}
        </MessageScrollerContent>
      </MessageScrollerViewport>
    </MessageScroller>
    </div>
  )
}
