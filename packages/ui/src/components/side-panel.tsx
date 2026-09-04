import { FolderTree, X } from 'lucide-react'

import { FileBrowser } from '@/components/file-browser'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * Tools that dock to the right of the main content, ChatGPT/Codex-desktop style. Adding a
 * terminal or browser later is one more row here; the chrome and the split are shared.
 */
export const SIDE_PANELS = {
  files: { label: 'Files', Icon: FolderTree, Body: FileBrowser }
} as const

export type SidePanelId = keyof typeof SIDE_PANELS

/** The header icons: one per panel, lit while open. */
export function SidePanelButtons({ open, onToggle, disabled }: { open?: SidePanelId; onToggle: (id: SidePanelId) => void; disabled: boolean }): React.JSX.Element {
  return (
    <>
      {(Object.keys(SIDE_PANELS) as SidePanelId[]).map((id) => {
        const { label, Icon } = SIDE_PANELS[id]
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={label} aria-pressed={open === id} disabled={disabled} className={open === id ? 'bg-accent' : undefined} onClick={() => onToggle(id)}>
                <Icon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{disabled ? `${label} — open a worktree first` : label}</TooltipContent>
          </Tooltip>
        )
      })}
    </>
  )
}

/** The docked panel itself: title bar with close, then the tool for the current worktree. */
export function SidePanel({ id, worktreeId, onClose }: { id: SidePanelId; worktreeId: string; onClose: () => void }): React.JSX.Element {
  const { label, Body } = SIDE_PANELS[id]
  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="text-xs font-medium">{label}</span>
        <Button variant="ghost" size="icon" className="size-6" aria-label={`Close ${label}`} onClick={onClose}>
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <Body key={worktreeId} worktreeId={worktreeId} />
      </div>
    </div>
  )
}
