import { useEffect, useRef, useState } from 'react'
import { PanelBottom, PanelRight, Plus, SquareTerminal, X } from 'lucide-react'

import { IconAction } from '@/components/icon-action'
import { useCloseTerminal, useCreateTerminal, useTerminals } from '@/lib/api-hooks'
import { cn } from '@/lib/utils'

import { useTerminalDock } from './terminal-dock'
import { TerminalView } from './terminal-view'

/**
 * The worktree's terminals: a tab per shell, a button for another, and the panel's own controls
 * — move it between the bottom and the right, or hide it. Opening it with no shell running starts
 * one; every shell keeps running in the daemon while the panel is hidden.
 */
export function TerminalPanel({ worktreeId, chrome = true }: { worktreeId: string; chrome?: boolean }): React.JSX.Element {
  const terminals = useTerminals(worktreeId)
  const create = useCreateTerminal(worktreeId)
  const close = useCloseTerminal(worktreeId)
  const dock = useTerminalDock()
  const [picked, setPicked] = useState<string>()
  const list = terminals.data ?? []
  const active = list.find((t) => t.id === picked)?.id ?? list.at(-1)?.id

  const start = (): void => create.mutate({}, { onSuccess: (terminal) => setPicked(terminal.id) })
  // One shell to begin with, once per worktree, so opening the panel is enough to start typing.
  const started = useRef<string>(undefined)
  useEffect(() => {
    if (terminals.data && terminals.data.length === 0 && started.current !== worktreeId) {
      started.current = worktreeId
      start()
    }
  }, [terminals.data, worktreeId])

  const other = dock.dock === 'bottom' ? 'right' : 'bottom'
  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-2">
        {chrome ? <SquareTerminal aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" /> : null}
        <div role="tablist" aria-label="Terminals" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
          {list.map((terminal, index) => (
            <span key={terminal.id} className={cn('group flex h-6 shrink-0 items-center rounded-[4px] text-xs', terminal.id === active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60')}>
              <button type="button" role="tab" aria-selected={terminal.id === active} onClick={() => setPicked(terminal.id)} className="px-2 outline-none">
                {terminal.title} {index + 1}
                {terminal.exitCode !== null ? <span className="ml-1 text-muted-foreground">(exited)</span> : null}
              </button>
              <button type="button" aria-label={`Close ${terminal.title} ${index + 1}`} onClick={() => close.mutate(terminal.id)} className="mr-0.5 grid size-4 place-items-center rounded-[3px] opacity-0 outline-none group-hover:opacity-100 hover:bg-foreground/10 focus-visible:opacity-100">
                <X aria-hidden="true" className="size-3" />
              </button>
            </span>
          ))}
          <IconAction label="New terminal" className="size-6" onClick={start}>
            <Plus aria-hidden="true" className="size-3.5" />
          </IconAction>
        </div>
        <IconAction label={other === 'right' ? 'Move the terminal to the right' : 'Move the terminal to the bottom'} className="size-6" onClick={() => dock.moveTo(other)}>
          {other === 'right' ? <PanelRight aria-hidden="true" className="size-3.5" /> : <PanelBottom aria-hidden="true" className="size-3.5" />}
        </IconAction>
        {chrome ? (
          <IconAction label="Hide the terminal" className="size-6" onClick={dock.toggle}>
            <X aria-hidden="true" className="size-3.5" />
          </IconAction>
        ) : null}
      </div>
      <div className="relative min-h-0 flex-1">
        {list.map((terminal) => (
          <TerminalView key={terminal.id} terminalId={terminal.id} active={terminal.id === active} />
        ))}
        {terminals.data && list.length === 0 && !create.isPending ? <p className="p-3 text-xs text-muted-foreground">No terminal open. Press + to start one.</p> : null}
      </div>
    </div>
  )
}
