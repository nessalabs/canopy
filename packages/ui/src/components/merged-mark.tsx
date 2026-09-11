import { GitMerge } from 'lucide-react'

import type { Worktree } from '@canopy/shared'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { mergedLabel } from '@/lib/status'
import { cn } from '@/lib/utils'

/**
 * A quiet tick for a worktree that is safe to let go: its branch has landed in its base and
 * there is nothing uncommitted left in the checkout. Everything else gets nothing here — an
 * unmerged branch is the ordinary state of a worktree, and uncommitted work is a reason to
 * keep it, so neither is a tick. The warnings belong where something is about to be destroyed.
 */
export function MergedMark({ worktree, side = 'right', className }: { worktree: Worktree; side?: 'right' | 'bottom'; className?: string }): React.JSX.Element | null {
  const merged = mergedLabel(worktree)
  if (!merged?.disposable) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <GitMerge role="img" aria-label={merged.label} className={cn('size-3 shrink-0 text-muted-foreground', className)} />
      </TooltipTrigger>
      <TooltipContent side={side}>{merged.label}</TooltipContent>
    </Tooltip>
  )
}
