import { useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { useLocation } from 'wouter'

import type { Worktree } from '@canopy/shared'

import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

import { DestroyWorktreeDialog } from './destroy-worktree-dialog'
import { WorktreeMenuItems } from './worktree-actions'

/**
 * The overflow menu a worktree gets where there is no room for its full action row — the
 * sidebar, for one. The same items as the status bar's branch menu; destroy opens the same
 * confirmation the dashboard uses. Leaving the worktree that is on screen sends the
 * reader home rather than to a dashboard for something that no longer exists.
 */
/**
 * Hidden until the row is hovered or keyboard-focused, and kept while the menu is open — a
 * fine pointer only; a touch screen has nothing to hover with, so there it simply shows.
 * Mirrors the sidebar's own `showTrailingOnHover`, which cannot be used here because it
 * would hide everything in the slot, the merged tick included.
 */
const REVEAL_ON_HOVER =
  '[@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover/menu-item:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-has-[:focus-visible]/menu-item:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:data-[state=open]:opacity-100 transition-opacity'

export function WorktreeMenu({ worktree, revealOnHover = false, className }: { worktree: Worktree; revealOnHover?: boolean; className?: string }): React.JSX.Element {
  const [location, navigate] = useLocation()
  const [destroyOpen, setDestroyOpen] = useState(false)
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Actions for ${worktree.name}`}
          className={cn(
            'inline-flex size-6 items-center justify-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
            revealOnHover && REVEAL_ON_HOVER,
            className
          )}
          // The row behind this is a link; a click here must not follow it.
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
          <WorktreeMenuItems worktree={worktree} onDestroy={() => setDestroyOpen(true)} />
        </DropdownMenuContent>
      </DropdownMenu>
      <DestroyWorktreeDialog
        worktree={worktree}
        open={destroyOpen}
        onOpenChange={setDestroyOpen}
        onDestroyed={() => {
          if (location === `/worktrees/${worktree.id}`) navigate('/')
        }}
      />
    </>
  )
}
