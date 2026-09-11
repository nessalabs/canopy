import { GitMerge } from 'lucide-react'

import type { Worktree } from '@canopy/shared'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { mergedLabel } from '@/lib/status'
import { cn } from '@/lib/utils'

/**
 * A quiet tick for a branch whose work has already landed in its base: the worktree is safe
 * to let go. Unmerged worktrees get nothing here — that is the ordinary state of a worktree,
 * and the warning belongs where something is about to be destroyed.
 */
export function MergedMark({ worktree, side = 'right', className }: { worktree: Worktree; side?: 'right' | 'bottom'; className?: string }): React.JSX.Element | null {
  const merged = mergedLabel(worktree)
  if (!merged?.merged) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <GitMerge role="img" aria-label={merged.label} className={cn('size-3 shrink-0 text-muted-foreground', className)} />
      </TooltipTrigger>
      <TooltipContent side={side}>{merged.label}</TooltipContent>
    </Tooltip>
  )
}
