import { useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { useLocation } from 'wouter'

import { isLive, type Worktree } from '@canopy/shared'

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useOpenWorktree, useProvisionWorktree, useWorktreeLifecycle } from '@/lib/api-hooks'
import { cn } from '@/lib/utils'

import { DestroyWorktreeDialog } from './destroy-worktree-dialog'
import { useToolLabels, WORKTREE_BUSY_STATES } from './worktree-actions'

/**
 * The overflow menu a worktree gets where there is no room for its full action row — the
 * sidebar, for one. Lifecycle, the configured editor and terminal, and destroy, which opens
 * the same confirmation the dashboard uses. Leaving the worktree that is on screen sends the
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
  const env = worktree.environment
  const lifecycle = useWorktreeLifecycle(worktree.id)
  const provision = useProvisionWorktree(worktree.id)
  const open = useOpenWorktree(worktree.id)
  const { editor, terminal } = useToolLabels()

  const busy = WORKTREE_BUSY_STATES.includes(env.state) || lifecycle.isPending || provision.isPending
  const live = isLive(env.state)
  const startable = !busy && (env.state === 'stopped' || env.state === 'error' || (env.state === 'none' && env.configured))
  const start = (): void => {
    if (env.state === 'none') provision.mutate({ autoStart: true })
    else lifecycle.mutate('start')
  }

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
          {startable ? <DropdownMenuItem onSelect={start}>{env.state === 'none' ? 'Provision & start' : 'Start'}</DropdownMenuItem> : null}
          {live ? (
            <>
              <DropdownMenuItem disabled={busy} onSelect={() => lifecycle.mutate('stop')}>
                Stop
              </DropdownMenuItem>
              <DropdownMenuItem disabled={busy} onSelect={() => lifecycle.mutate('restart')}>
                Restart
              </DropdownMenuItem>
            </>
          ) : null}
          {startable || live ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem onSelect={() => open.mutate({ target: 'editor' })}>Open in {editor}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => open.mutate({ target: 'terminal' })}>Open in {terminal}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" disabled={worktree.isMain || busy} onSelect={() => setDestroyOpen(true)}>
            Destroy worktree…
          </DropdownMenuItem>
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
