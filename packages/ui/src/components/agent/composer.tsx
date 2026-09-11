import { useEffect, useMemo, useRef, useState } from 'react'
import { AtSign, Brain, FileDiff, Plus, Square, Users } from 'lucide-react'

import { ImageMediaType, type ChangedFile, type Effort } from '@canopy/shared'
import type { ContextUsage } from '@canopy/shared/agent-stream'

import {
  ChatComposer,
  ChatComposerAction,
  ChatComposerActions,
  ChatComposerAttachment,
  ChatComposerAttachments,
  ChatComposerFooter,
  ChatComposerInput,
  ChatComposerSubmit,
  ChatComposerTrigger
} from '@/components/ui/chat-composer'
import { ComposerAccessMode } from '@/components/ui/composer-access-mode'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ModelThinkingControl } from '@/components/ui/model-capability-controls'
import { ModelPicker } from '@/components/ui/model-picker'

import { SearchableListbox } from '@/components/ui/searchable-listbox'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ACCESS_TO_AUTONOMY, AUTONOMY_TO_ACCESS } from '@/lib/autonomy'
import { agentMention, commandMenu, composeMessage, isNewSessionCommand, type Attachment, type CommandItem, type MentionItem } from '@/lib/compose'
import { plural } from '@/lib/format'
import { effortLevelsFor, modelGroupFor } from '@/lib/models'
import type { WorktreeAgent } from '@/lib/use-worktree-agent'

import { ContextMeter } from './context-meter'


let nextAttachmentId = 0
const attach = (kind: Attachment['kind'], label: string, text: string): Attachment => ({ id: `att-${++nextAttachmentId}`, kind, label, text })

/** Reads a pasted image file into the base64 form the agent API takes. */
function readImage(file: File): Promise<Attachment | null> {
  const media = ImageMediaType.safeParse(file.type)
  if (!media.success) return Promise.resolve(null)
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      const data = String(reader.result).split(',')[1] ?? ''
      resolve({ ...attach('file', 'Image', ''), image: { mediaType: media.data, data } })
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

const dataUrl = (image: NonNullable<Attachment['image']>): string => `data:${image.mediaType};base64,${image.data}`

/** One `/` row: the command, what it does, what it takes, and which list it came from. */
function CommandRow({ item }: { item: CommandItem }): React.JSX.Element {
  return (
    <span className="flex w-full min-w-0 items-baseline gap-2">
      <span className="shrink-0 font-mono text-sm text-foreground">/{item.name}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{item.description}</span>
      {item.argumentHint ? <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{item.argumentHint}</span> : null}
      <span className="shrink-0 rounded-sm bg-muted px-1 py-px nessa-text-1 text-muted-foreground">{item.group}</span>
    </span>
  )
}

/** One `@` row: a changed file, or a subagent the session can hand work to. */
function MentionRow({ item }: { item: MentionItem }): React.JSX.Element {
  if (item.kind === 'file') return <span className="min-w-0 truncate font-mono text-sm">{item.path}</span>
  return (
    <span className="flex w-full min-w-0 items-baseline gap-2">
      <Users aria-hidden="true" className="size-3.5 shrink-0 self-center text-muted-foreground" />
      <span className="shrink-0 font-mono text-sm text-foreground">@agent-{item.agent.name}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{item.agent.description}</span>
    </span>
  )
}

/**
 * The nessa ChatComposer as a review tool: staged context chips, `/` prompts, `@` file
 * mentions, and per-turn knobs (access mode, model, effort) that reach the resumed session.
 */
export function AgentComposer({
  agent,
  changedFiles,
  placeholder,
  latestChanges,
  quote,
  onQuoteStaged,
  context = null
}: {
  agent: WorktreeAgent
  changedFiles: ChangedFile[]
  placeholder: string
  /** The changes panel: how many files the newest turn wrote, whether the panel is open, and the toggle. */
  latestChanges: { count: number; shown: boolean; onToggle: () => void }
  /** Transcript text to stage as context. `id` changes per request, so the same text can be quoted twice. */
  quote?: { id: number; text: string }
  /** Fires once the quote is a chip, so the owner can drop it rather than hand it over again. */
  onQuoteStaged?: () => void
  /** How full the session's context window is, for the meter beside the model picker. */
  context?: ContextUsage | null
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  // The picked command's argument hint, shown as the input's placeholder rather than as text the
  // agent would have to read past.
  const [hint, setHint] = useState<{ name: string; text: string }>()
  const { busy } = agent.turn
  const ready = agent.selected !== undefined || agent.fresh !== undefined
  // A running turn takes typing too: the daemon folds it into the turn rather than starting another.
  const canSend = ready && (draft.trim() !== '' || attachments.length > 0)
  const provider = agent.selected?.provider ?? agent.fresh ?? 'claude'
  const capabilities = agent.capabilities
  const commands = useMemo(() => commandMenu(capabilities?.commands), [capabilities?.commands])
  const mentions = useMemo<MentionItem[]>(
    () => [
      ...changedFiles.map((file): MentionItem => ({ kind: 'file', id: `file:${file.path}`, path: file.path })),
      ...(capabilities?.agents ?? []).map((agentInfo): MentionItem => ({ kind: 'agent', id: `agent:${agentInfo.name}`, agent: agentInfo }))
    ],
    [changedFiles, capabilities?.agents]
  )
  const effortLevels = effortLevelsFor(agent.model, capabilities?.models)
  const effort = agent.effort ?? 'medium'
  const effortValue = effortLevels.some((level) => level.value === effort) ? effort : effortLevels[0]?.value

  const add = (attachment: Attachment): void => setAttachments((current) => [...current, attachment])
  const remove = (id: string): void => setAttachments((current) => current.filter((a) => a.id !== id))

  const inputRef = useRef<HTMLTextAreaElement>(null)

  // A quote from the transcript arrives as a chip, with the cursor left in the input to ask about it.
  // The id guard covers a repeat effect run; the owner dropping the quote covers a remount.
  const staged = useRef<number>(undefined)
  useEffect(() => {
    if (!quote || staged.current === quote.id) return
    staged.current = quote.id
    add(attach('pasted-text', `Quoted from the transcript (${plural(quote.text.split('\n').length, 'line')})`, quote.text))
    inputRef.current?.focus()
    onQuoteStaged?.()
  }, [quote, onQuoteStaged])

  const clear = (): void => {
    setDraft('')
    setAttachments([])
    setHint(undefined)
  }

  const submit = (): void => {
    if (!canSend) return
    // `/clear` and friends live inside the CLI's own process, so Canopy answers them the only way
    // a client can: the next message starts a new session. Nothing is sent.
    if (isNewSessionCommand(draft)) {
      agent.startSession(provider)
      clear()
      return
    }
    const images = attachments.filter((a) => a.image).map((a) => ({ label: a.label, ...a.image! }))
    const shown = { display: draft.trim(), attachments: attachments.filter((a) => !a.image), images }
    const text = composeMessage(draft, attachments)
    void (busy ? agent.turn.queueMessage(text, shown) : agent.turn.sendMessage(text, shown))
    clear()
  }

  /** Images from the clipboard become numbered image attachments; text pastes stay with the input. */
  const pasteImages = async (event: React.ClipboardEvent<HTMLTextAreaElement>): Promise<void> => {
    const files = [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'))
    if (files.length === 0) return
    event.preventDefault()
    const read = (await Promise.all(files.map(readImage))).filter((a): a is Attachment => a !== null)
    setAttachments((current) => {
      const offset = current.filter((a) => a.image).length
      return [...current, ...read.map((a, i) => ({ ...a, label: `Image #${offset + i + 1}` }))]
    })
  }

  /**
   * A Canopy prompt is text the agent reads; a real command is a line it executes, so it goes
   * into the input as `/name ` for the arguments to be typed after — with its argument hint shown
   * as the placeholder rather than as text that would be sent along.
   */
  const pickCommand = (item: CommandItem, clearTrigger: (replaceWith?: string) => void): void => {
    if (item.prompt !== undefined) {
      clearTrigger()
      setDraft((current) => (current.trim() ? `${current.trim()}\n${item.prompt}` : (item.prompt ?? '')))
      return
    }
    clearTrigger(`/${item.name} `)
    setHint(item.argumentHint ? { name: item.name, text: item.argumentHint } : undefined)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  // The hint belongs to the command still in the input; typing something else retires it.
  const activeHint = hint && draft.trimStart().startsWith(`/${hint.name}`) ? hint.text : undefined
  const inputPlaceholder = !ready ? 'Pick a session to chat' : (activeHint ?? `${placeholder} — / for commands, @ for files and agents`)

  /** Typing "@" is what opens the mention menu, so the + menu does exactly that. */
  const openMentions = (): void => {
    setDraft((current) => `${current}${current && !current.endsWith(' ') ? ' ' : ''}@`)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  return (
    <ChatComposer
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      {attachments.length > 0 ? (
        <ChatComposerAttachments>
          {attachments.map((attachment) => (
            <ChatComposerAttachment
              key={attachment.id}
              // Images are their own label: a larger thumbnail, no kind glyph, no text.
              kind={attachment.image ? undefined : attachment.kind}
              itemLabel={attachment.label}
              className={attachment.image ? 'h-auto p-1' : undefined}
              onRemove={() => remove(attachment.id)}
            >
              {attachment.image ? <img src={dataUrl(attachment.image)} alt={attachment.label} className="h-20 w-auto max-w-48 rounded-md object-cover" /> : attachment.label}
            </ChatComposerAttachment>
          ))}
        </ChatComposerAttachments>
      ) : null}
      <ChatComposerInput
        ref={inputRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onPaste={(event) => void pasteImages(event)}
        onPasteAttachment={(text) => add(attach('pasted-text', `Pasted text (${plural(text.split('\n').length, 'line')})`, text))}
        placeholder={inputPlaceholder}
        aria-label="Message the agent"
        disabled={!ready}
      />
      <ChatComposerTrigger trigger="/" label="Commands">
        {({ query, clearTrigger }) => (
          <SearchableListbox
            items={commands}
            query={query}
            getItemId={(item) => item.id}
            getItemKeywords={(item) => [item.name, item.description, item.group, ...(item.aliases ?? [])]}
            renderItem={(item) => <CommandRow item={item} />}
            onValueChange={(_, item) => pickCommand(item, clearTrigger)}
            listLabel="Commands"
            emptyMessage="No matching command"
            className="max-h-72"
          />
        )}
      </ChatComposerTrigger>
      <ChatComposerTrigger trigger="@" label="Mention a file or a subagent">
        {({ query, clearTrigger }) => (
          <SearchableListbox
            items={mentions}
            query={query}
            getItemId={(item) => item.id}
            getItemKeywords={(item) => (item.kind === 'file' ? [item.path] : [item.agent.name, item.agent.description, 'subagent', 'agent'])}
            renderItem={(item) => <MentionRow item={item} />}
            onValueChange={(_, item) => {
              if (item.kind === 'agent') {
                // The CLI's own syntax for addressing a subagent, so it belongs in the text.
                clearTrigger(agentMention(item.agent.name))
                return
              }
              clearTrigger()
              add(attach('mention', item.path.split('/').pop() ?? item.path, item.path))
            }}
            listLabel="Files and subagents"
            emptyMessage="Nothing matches"
            className="max-h-72"
          />
        )}
      </ChatComposerTrigger>
      <ChatComposerFooter>
        <ChatComposerActions>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <ChatComposerAction aria-label="Add context" title="Add context" disabled={!ready}>
                <Plus aria-hidden="true" />
              </ChatComposerAction>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={openMentions} disabled={changedFiles.length === 0}>
                <AtSign aria-hidden="true" /> Mention a changed file…
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={changedFiles.length === 0}
                onSelect={() => add(attach('file', plural(changedFiles.length, 'changed file'), changedFiles.map((f) => `${f.status} ${f.path}`).join('\n')))}
              >
                <FileDiff aria-hidden="true" /> Attach the list of {plural(changedFiles.length, 'changed file')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <ComposerAccessMode value={AUTONOMY_TO_ACCESS[agent.autonomy]} onValueChange={(value) => agent.setAutonomy(ACCESS_TO_AUTONOMY[value])} aria-label="Agent access mode" />
        </ChatComposerActions>
        <ChatComposerActions className="justify-end">
          <Tooltip>
            <TooltipTrigger asChild>
              <ChatComposerAction aria-label={latestChanges.shown ? 'Hide code changes' : 'Show code changes'} aria-pressed={latestChanges.shown} className={latestChanges.shown ? 'bg-accent text-foreground' : undefined} onClick={latestChanges.onToggle}>
                <FileDiff aria-hidden="true" />
              </ChatComposerAction>
            </TooltipTrigger>
            <TooltipContent>
              {latestChanges.shown ? 'Hide the changes panel' : latestChanges.count === 0 ? 'Changes panel (no turn has changed files yet)' : `Show changes · latest turn wrote ${plural(latestChanges.count, 'file')}`}
            </TooltipContent>
          </Tooltip>
          <ContextMeter usage={context} model={agent.history.data?.model} />
          <ModelPicker
            groups={[modelGroupFor(provider, agent.model, capabilities?.models)]}
            value={agent.model ? { providerId: provider, modelId: agent.model } : undefined}
            onValueChange={(value) => agent.setModel(value.modelId)}
            placeholder="Session model"
            triggerLabel={busy ? 'Model, from the next call on' : 'Model for the next turn'}
          />
          <ModelThinkingControl
            icon={<Brain className="size-4.5" aria-hidden="true" />}
            levels={effortLevels}
            value={effortValue}
            onValueChange={(value) => agent.setEffort(value as Effort)}
            triggerLabel="Reasoning effort"
          />
          {busy ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <ChatComposerAction aria-label="Stop the agent" onClick={agent.turn.stop} className="text-destructive">
                  <Square aria-hidden="true" />
                </ChatComposerAction>
              </TooltipTrigger>
              <TooltipContent>Stop this turn</TooltipContent>
            </Tooltip>
          ) : null}
          {busy ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <ChatComposerSubmit aria-label="Queue" disabled={!canSend} className="w-auto px-3 text-xs font-medium">
                  Queue
                </ChatComposerSubmit>
              </TooltipTrigger>
              <TooltipContent>Send to the running turn</TooltipContent>
            </Tooltip>
          ) : (
            <ChatComposerSubmit aria-label="Send" disabled={!canSend} />
          )}
        </ChatComposerActions>
      </ChatComposerFooter>
    </ChatComposer>
  )
}
