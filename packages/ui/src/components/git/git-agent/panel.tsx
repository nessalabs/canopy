import { useState } from 'react'
import { X } from 'lucide-react'

import type { Worktree } from '@canopy/shared'

import { AgentAvatar } from '@/components/agent/agent-avatar'
import type { OpenFileRef } from '@/components/agent/answer-links'
import { NewSessionButton } from '@/components/agent/new-session-button'
import { ProviderIcon } from '@/components/agent/provider-icon'
import { Button } from '@/components/ui/button'
import { StatusDot } from '@/components/ui/status-dot'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { readDrop, toStaged } from '@/lib/agent-context'
import type { AgentTab } from '@/lib/git-agent'
import type { GitAgent } from '@/lib/use-git-agent'
import { cn } from '@/lib/utils'

import { GitAgentConversation, type TabMeta } from './conversation'
import { DropZone, carriesContext, useDragAnywhere } from './drop-zone'
import { STATUS_LOOK } from './status'

/** One tab in the strip: whose conversation it is, how it is doing, and a way to close it. */
function TabButton({ tab, meta, active, onSelect, onClose }: { tab: AgentTab; meta: TabMeta | undefined; active: boolean; onSelect: () => void; onClose: () => void }): React.JSX.Element {
  const status = meta?.status ?? 'idle'
  const look = STATUS_LOOK[status]
  const title = meta?.title ?? 'New session'
  return (
    <div
      role="tab"
      aria-selected={active}
      className={cn(
        'group/tab relative flex h-8 max-w-44 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-md ps-2 pe-1 text-xs transition-colors',
        active ? 'bg-background text-foreground shadow-xs ring-1 ring-border' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        look.tint
      )}
      onClick={onSelect}
    >
      <span className="relative inline-flex shrink-0">
        <AgentAvatar seed={meta?.seed ?? tab.id} activity={meta?.running ? 'working' : null} className="size-4" />
        <StatusDot status={look.dot} className="absolute -right-0.5 -bottom-0.5 size-1.5 ring-2 ring-card" />
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="min-w-0 flex-1 truncate">{title}</span>
        </TooltipTrigger>
        <TooltipContent>
          {title} · {look.label}
        </TooltipContent>
      </Tooltip>
      <Button
        variant="ghost"
        size="icon"
        className="size-5 shrink-0 opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100 data-[active=true]:opacity-100"
        data-active={active}
        aria-label={`Close ${title}`}
        onClick={(event) => {
          event.stopPropagation()
          onClose()
        }}
      >
        <X className="size-3" />
      </Button>
    </div>
  )
}

/** No tab yet: one button per provider, so starting a conversation is the obvious thing to do. */
function Empty({ seed, providers, onStart }: { seed: string; providers: GitAgent['providers']; onStart: GitAgent['newTab'] }): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <AgentAvatar seed={seed} className="size-12" />
      <p className="text-sm font-semibold">Ask the Git Agent</p>
      <p className="max-w-64 text-xs text-muted-foreground">About the diff, a commit or the pull request. Highlight code or drag files here to give it context; comments you send for review land here too.</p>
      <div className="flex flex-wrap justify-center gap-2">
        {providers.map((provider) => (
          <Button key={provider} size="sm" variant="outline" className="h-7 text-xs" onClick={() => onStart(provider)}>
            <ProviderIcon provider={provider} className="size-3.5" />
            New {provider === 'claude' ? 'Claude' : 'Codex'} session
          </Button>
        ))}
      </div>
    </div>
  )
}

/**
 * The Git Agent, docked beside every Git pane: tabs of conversations about this worktree's
 * change, each running on its own and coloured by how it is doing. Files and code dropped on it
 * join the tab on screen as context; files its answers cite open in the pane beside it.
 */
export function GitAgentPanel({ worktree, agent, seed, onOpenRef }: { worktree: Worktree; agent: GitAgent; seed: string; onOpenRef: OpenFileRef }): React.JSX.Element {
  const [metas, setMetas] = useState<Record<string, TabMeta>>({})
  const [over, setOver] = useState(false)
  const drag = useDragAnywhere()
  const { active } = agent

  const drop = {
    onDragOver: (event: React.DragEvent) => {
      if (!carriesContext(event.dataTransfer)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      setOver(true)
    },
    onDragLeave: (event: React.DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false)
    },
    // Captured, so text dropped on the input becomes a chip instead of being typed into it.
    onDropCapture: (event: React.DragEvent) => {
      setOver(false)
      drag.done()
      const context = carriesContext(event.dataTransfer) ? readDrop(event.dataTransfer) : null
      if (!context) return
      event.preventDefault()
      event.stopPropagation()
      agent.ask(toStaged(context))
    }
  }

  return (
    <div {...drop} className="@container relative flex h-full min-h-0 flex-col bg-card">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border ps-2 pe-1.5">
        <span className="flex shrink-0 items-center gap-1.5 pe-1 text-xs font-semibold">
          <AgentAvatar seed={seed} className="size-4" />
          Git Agent
        </span>
        <div role="tablist" aria-label="Git Agent conversations" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-0.5 [scrollbar-width:none]">
          {agent.tabs.map((tab) => (
            <TabButton key={tab.id} tab={tab} meta={metas[tab.id]} active={tab.id === active} onSelect={() => agent.activate(tab.id)} onClose={() => agent.close(tab.id)} />
          ))}
        </div>
        <NewSessionButton providers={agent.providers} onStart={agent.newTab} />
        <Button variant="ghost" size="icon" className="size-6" aria-label="Close Git Agent" onClick={() => agent.setOpen(false)}>
          <X className="size-3.5" />
        </Button>
      </div>
      {agent.tabs.length === 0 ? <Empty seed={seed} providers={agent.providers} onStart={agent.newTab} /> : null}
      <div className="min-h-0 flex-1 empty:hidden">
        {agent.tabs.map((tab) => (
          <GitAgentConversation
            key={tab.id}
            worktree={worktree}
            tab={tab}
            onOpenRef={onOpenRef}
            active={tab.id === active}
            staging={agent.staging(tab.id)}
            outgoing={agent.outbox[tab.id]}
            onSent={() => agent.sent(tab.id)}
            onSession={(session) => agent.bind(tab.id, session)}
            onMeta={(meta) => {
              setMetas((current) => ({ ...current, [tab.id]: meta }))
              agent.report(tab.id, meta.status)
            }}
          />
        ))}
      </div>
      {drag.dragging || over ? <DropZone seed={seed} over={over} /> : null}
    </div>
  )
}
