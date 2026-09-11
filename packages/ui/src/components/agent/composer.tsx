import { useEffect, useRef, useState } from 'react'
import { AtSign, Brain, FileDiff, Plus, Square } from 'lucide-react'

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
import { SLASH_COMMANDS, composeMessage, type Attachment } from '@/lib/compose'
import { plural } from '@/lib/format'
import { EFFORT_LEVELS, modelGroupFor } from '@/lib/models'
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
  const { busy } = agent.turn
  const ready = agent.selected !== undefined || agent.fresh !== undefined
  const canSend = ready && !busy && (draft.trim() !== '' || attachments.length > 0)
  const provider = agent.selected?.provider ?? agent.fresh ?? 'claude'

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

  const submit = (): void => {
    if (!canSend) return
    const images = attachments.filter((a) => a.image).map((a) => ({ label: a.label, ...a.image! }))
    void agent.turn.sendMessage(composeMessage(draft, attachments), { display: draft.trim(), attachments: attachments.filter((a) => !a.image), images })
    setDraft('')
    setAttachments([])
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
        placeholder={ready ? `${placeholder} — / for prompts, @ for files` : 'Pick a session to chat'}
        aria-label="Message the agent"
        disabled={!ready}
      />
      <ChatComposerTrigger trigger="/" label="Review prompts">
        {({ query, clearTrigger }) => (
          <SearchableListbox
            items={SLASH_COMMANDS}
            query={query}
            getItemId={(item) => item.id}
            getItemKeywords={(item) => [item.label, item.description]}
            renderItem={(item) => (
              <span className="flex flex-col">
                <span className="font-mono text-sm">/{item.label}</span>
                <span className="text-xs text-muted-foreground">{item.description}</span>
              </span>
            )}
            onValueChange={(_, item) => {
              clearTrigger()
              setDraft((current) => (current.trim() ? `${current.trim()}\n${item.prompt}` : item.prompt))
            }}
            listLabel="Review prompts"
            emptyMessage="No matching prompt"
            className="max-h-64"
          />
        )}
      </ChatComposerTrigger>
      <ChatComposerTrigger trigger="@" label="Mention a changed file">
        {({ query, clearTrigger }) => (
          <SearchableListbox
            items={changedFiles}
            query={query}
            getItemId={(file) => file.path}
            getItemKeywords={(file) => [file.path]}
            renderItem={(file) => <span className="font-mono text-sm">{file.path}</span>}
            onValueChange={(_, file) => {
              clearTrigger()
              add(attach('mention', file.path.split('/').pop() ?? file.path, file.path))
            }}
            listLabel="Changed files"
            emptyMessage="No changed files match"
            className="max-h-64"
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
            groups={[modelGroupFor(provider, agent.model)]}
            value={agent.model ? { providerId: provider, modelId: agent.model } : undefined}
            onValueChange={(value) => agent.setModel(value.modelId)}
            placeholder="Session model"
            triggerLabel="Model for the next turn"
          />
          <ModelThinkingControl
            icon={<Brain className="size-4.5" aria-hidden="true" />}
            levels={EFFORT_LEVELS}
            value={agent.effort ?? 'medium'}
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
          <ChatComposerSubmit aria-label="Send" disabled={!canSend} loading={busy} />
        </ChatComposerActions>
      </ChatComposerFooter>
    </ChatComposer>
  )
}
