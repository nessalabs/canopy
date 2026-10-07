import { FolderTree, Moon, PanelLeft, Settings2, Sun } from 'lucide-react'
import { Popover } from 'radix-ui'
import { Link, useLocation } from 'wouter'

import { IconAction } from '@/components/icon-action'
import { ShellSlotTarget } from '@/components/shell-slots'
import { Button } from '@/components/ui/button'
import { PopoverSurface } from '@/components/ui/popover-surface'
import { useSidebar } from '@/components/ui/sidebar'
import { StatusDot } from '@/components/ui/status-dot'
import { useEventsConnection } from '@/lib/events-provider'
import { useTheme } from '@/lib/use-theme'
import { cn } from '@/lib/utils'
import { useApi } from '@/providers/api'

/** The thin rule between groups of status-bar items. */
export function StatusDivider(): React.JSX.Element {
  return <span aria-hidden className="mx-1 h-3.5 w-px shrink-0 bg-border" />
}

/** A status-bar item that opens a popover above it — the bar's only way to show more. */
export function StatusPopover({
  trigger,
  label,
  align = 'start',
  className,
  children
}: {
  trigger: React.ReactNode
  label: string
  align?: 'start' | 'end'
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button variant="ghost" size="sm" aria-label={label} className="h-6 gap-1.5 px-1.5 font-mono text-xs font-normal text-muted-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground">
          {trigger}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content asChild side="top" align={align} sideOffset={6} collisionPadding={8}>
          <PopoverSurface className={cn('p-0', className)}>{children}</PopoverSurface>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

/** One `label  value` line in a status popover. */
export function StatusRow({ label, children, className }: { label: string; children: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className={cn('min-w-0 truncate font-mono', className)}>{children}</span>
    </div>
  )
}

/** The daemon's connection, where it is, and the ways into its docs and preferences. */
function Health(): React.JSX.Element {
  const connection = useEventsConnection()
  const api = useApi()
  const live = connection === 'live'
  return (
    <StatusPopover
      label="Daemon health"
      align="end"
      className="w-72"
      trigger={
        <>
          <StatusDot status={live ? 'success' : 'running'} />
          canopyd · {live ? 'live' : 'reconnecting…'}
        </>
      }
    >
      <div className="border-b border-border px-3 py-2 text-sm font-medium">Health</div>
      <div className="flex flex-col gap-1.5 px-3 py-2.5">
        <StatusRow label="canopyd" className={live ? 'text-nessa-diff-addition' : 'text-muted-foreground'}>
          {live ? 'live' : 'reconnecting…'}
        </StatusRow>
        <StatusRow label="Address">{new URL(api.baseUrl).host}</StatusRow>
        <StatusRow label="API">
          <Link href="/docs" className="underline-offset-2 hover:underline">
            docs
          </Link>
        </StatusRow>
      </div>
    </StatusPopover>
  )
}

/**
 * The app's bottom bar: panel toggles on the left, then whatever the open worktree puts in the
 * `status` slot (branch, sync, changes); on the right the worktree's popovers, the daemon's
 * health, preferences and the theme. It replaces the top bar's old right-hand icons, so the
 * screen above starts one row higher.
 */
export function StatusBar({ filesOpen, filesDisabled, onToggleFiles }: { filesOpen: boolean; filesDisabled: boolean; onToggleFiles: () => void }): React.JSX.Element {
  const { open: sidebarOpen, toggleSidebar } = useSidebar()
  const { theme, toggleTheme } = useTheme()
  const [location, navigate] = useLocation()
  const pressed = 'bg-accent text-foreground'
  return (
    <footer className="flex h-8 shrink-0 items-center gap-0.5 border-t border-border bg-surface-panel px-1.5 font-mono text-xs text-muted-foreground">
      <IconAction label="Sidebar  [" pressed={sidebarOpen} className={cn('w-7', sidebarOpen && pressed)} onClick={toggleSidebar}>
        <PanelLeft className="size-3.5" />
      </IconAction>
      <IconAction label={filesDisabled ? 'Files — open a worktree first' : 'Files  \\'} pressed={filesOpen} className={cn('w-7', filesOpen && pressed)} onClick={filesDisabled ? () => undefined : onToggleFiles}>
        <FolderTree className="size-3.5" />
      </IconAction>
      <StatusDivider />
      <ShellSlotTarget name="status" className="flex min-w-0 items-center gap-0.5 overflow-hidden" />
      <div className="flex-1" />
      <ShellSlotTarget name="statusEnd" className="flex shrink-0 items-center gap-0.5 empty:hidden" />
      <Health />
      <StatusDivider />
      <IconAction label="Preferences" pressed={location === '/settings'} className={cn('w-7', location === '/settings' && pressed)} onClick={() => navigate('/settings')}>
        <Settings2 className="size-3.5" />
      </IconAction>
      <IconAction label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} className="w-7" onClick={toggleTheme}>
        {theme === 'dark' ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
      </IconAction>
    </footer>
  )
}
