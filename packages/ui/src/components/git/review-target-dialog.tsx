import { useState } from 'react'
import { Bot, Check, Plus } from 'lucide-react'

import type { AgentProvider, AgentSessionSummary } from '@canopy/shared'

import { ProviderIcon } from '@/components/agent/provider-icon'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SearchableListbox } from '@/components/ui/searchable-listbox'
import { Textarea } from '@/components/ui/textarea'
import { plural, relativeTime } from '@/lib/format'
import type { ReviewTarget } from '@/lib/use-agent-turn'

/** A row of the picker: an existing session, or a "start new" entry per installed provider. */
type Choice = { id: string; target: ReviewTarget; title: string; detail: string; isNew: boolean }

const NAMES: Record<AgentProvider, string> = { claude: 'Claude Code', codex: 'Codex' }

function choices(providers: AgentProvider[], sessions: AgentSessionSummary[]): Choice[] {
  const fresh = providers.map<Choice>((provider) => ({ id: `new:${provider}`, target: { provider, sessionId: null }, title: `New ${NAMES[provider]} session`, detail: 'Starts with this review', isNew: true }))
  const existing = sessions.map<Choice>((s) => ({
    id: `${s.provider}:${s.sessionId}`,
    target: { provider: s.provider, sessionId: s.sessionId },
    title: s.title || s.sessionId.slice(0, 8),
    detail: `${NAMES[s.provider]} · ${relativeTime(s.updatedAt)}`,
    isNew: false
  }))
  return [...fresh, ...existing]
}

/** Picks where the unsent comments go, with an optional note for the agent. */
export function ReviewTargetDialog({
  open,
  onOpenChange,
  providers,
  sessions,
  initialTarget,
  count,
  onSend
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  providers: AgentProvider[]
  sessions: AgentSessionSummary[]
  initialTarget?: ReviewTarget
  count: number
  onSend: (target: ReviewTarget, note: string | undefined) => void
}): React.JSX.Element {
  const items = choices(providers, sessions)
  const [picked, setPicked] = useState<string>()
  const [note, setNote] = useState('')
  const initialId = initialTarget ? `${initialTarget.provider}:${initialTarget.sessionId}` : items[0]?.id
  const selected = items.find((c) => c.id === (picked ?? initialId))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Send {plural(count, 'comment')} for review</DialogTitle>
          <DialogDescription>Choose the agent session that should address them, or start a new one.</DialogDescription>
        </DialogHeader>
        <div className="overflow-hidden rounded-xl border border-border">
          <SearchableListbox
            items={items}
            getItemId={(c) => c.id}
            getItemKeywords={(c) => [c.title, c.detail]}
            value={selected?.id}
            onValueChange={setPicked}
            searchPlaceholder="Search sessions"
            listLabel="Review destination"
            renderItem={(c, state) => (
              <span className="grid w-full grid-cols-[1.5rem_minmax(0,1fr)_1.25rem] items-center gap-2 px-2 py-1.5">
                {c.isNew ? <Plus className="size-4 text-muted-foreground" /> : <ProviderIcon provider={c.target.provider} className="size-4" />}
                <span className="min-w-0">
                  <span className="block truncate text-sm">{c.title}</span>
                  <span className="block truncate font-mono text-[10px] text-muted-foreground">{c.detail}</span>
                </span>
                {state.selected ? <Check className="size-4" /> : null}
              </span>
            )}
          />
        </div>
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional note for the agent…" className="min-h-16 text-xs" aria-label="Note for the agent" />
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={!selected} onClick={() => selected && onSend(selected.target, note.trim() || undefined)}>
            <Bot />
            Send to {selected?.isNew ? 'new session' : 'session'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
