import { Maximize2, Minimize2, X } from 'lucide-react'

import { FileBrowser } from '@/components/file-browser'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * Tools that dock to the right of the main content, ChatGPT/Codex-desktop style. Adding a
 * terminal or browser later is one more row here; the chrome and the split are shared.
 */
export const SIDE_PANELS = {
  files: { label: 'Files', Body: FileBrowser }
} as const

export type SidePanelId = keyof typeof SIDE_PANELS

/**
 * The docked panel itself: title bar with full-screen and close, then the tool for the current
 * worktree. Full screen hands the panel the whole content area — a doc or a wide file is worth
 * more than the sliver a docked panel can spare.
 */
export function SidePanel({ id, worktreeId, full, onToggleFull, onClose }: {
  id: SidePanelId
  worktreeId: string
  full: boolean
  onToggleFull: () => void
  onClose: () => void
}): React.JSX.Element {
  const { label, Body } = SIDE_PANELS[id]
  const fullLabel = full ? 'Exit full screen' : `${label} full screen`
  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="text-xs font-medium">{label}</span>
        <span className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="size-6" aria-label={fullLabel} aria-pressed={full} onClick={onToggleFull}>
                {full ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{fullLabel}</TooltipContent>
          </Tooltip>
          <Button variant="ghost" size="icon" className="size-6" aria-label={`Close ${label}`} onClick={onClose}>
            <X className="size-3.5" />
          </Button>
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <Body key={worktreeId} worktreeId={worktreeId} />
      </div>
    </div>
  )
}
