import { ExternalLink, Play, RotateCw, Square } from 'lucide-react'

import { EDITOR_PRESETS, TERMINAL_PRESETS, isLive, primaryService, type EditorId, type TerminalId, type Worktree } from '@canopy/shared'

import { errorMessage } from '@/components/error-note'
import { Button } from '@/components/ui/button'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppSettings, useOpenWorktree, useProvisionWorktree, useRegenerateEnvFile, useWorktreeLifecycle } from '@/lib/api-hooks'
import { usePlatform } from '@/providers/platform'

/** States in which a lifecycle command is already in flight; every button waits it out. */
export const WORKTREE_BUSY_STATES = ['creating', 'provisioning', 'starting', 'stopping', 'destroying']

const label = (presets: Record<string, { label: string }>, id: string, fallback: string): string => (id === 'custom' ? fallback : (presets[id]?.label ?? fallback))

/** What "open in …" should call the configured editor and terminal. */
export function useToolLabels(): { editor: string; terminal: string } {
  const settings = useAppSettings().data
  return {
    editor: label(EDITOR_PRESETS as Record<EditorId, { label: string }>, settings?.editor.id ?? 'custom', 'editor'),
    terminal: label(TERMINAL_PRESETS as Record<TerminalId, { label: string }>, settings?.terminal.id ?? 'custom', 'terminal')
  }
}

/**
 * Everything a worktree's controls need to know and do, in one place for every surface that
 * shows them — the top bar's primary action, the sidebar row's menu and the status bar's branch
 * menu — so the three never disagree on when Start is offered or what Stop waits for.
 */
export function useWorktreeControls(worktree: Worktree) {
  const env = worktree.environment
  const lifecycle = useWorktreeLifecycle(worktree.id)
  const provision = useProvisionWorktree(worktree.id)
  const regenerate = useRegenerateEnvFile(worktree.id)
  const open = useOpenWorktree(worktree.id)
  const busy = WORKTREE_BUSY_STATES.includes(env.state) || lifecycle.isPending || provision.isPending
  return {
    busy,
    live: isLive(env.state),
    provisioned: env.state !== 'none',
    startable: !busy && (env.state === 'stopped' || env.state === 'error' || (env.state === 'none' && env.configured)),
    failure: lifecycle.error ?? provision.error ?? regenerate.error ?? open.error,
    start: (): void => (env.state === 'none' ? provision.mutate({ autoStart: true }) : lifecycle.mutate('start')),
    stop: (): void => lifecycle.mutate('stop'),
    restart: (): void => lifecycle.mutate('restart'),
    provision: (): void => provision.mutate(env.state !== 'none' ? { from: 'run-setup' } : {}),
    regenerate: (): void => regenerate.mutate(),
    regenerating: regenerate.isPending,
    openIn: (target: 'editor' | 'terminal'): void => open.mutate({ target })
  }
}

/**
 * The top bar's primary action for a worktree: Start, or Stop and Restart while it runs, with
 * the primary service's URL beside them and the daemon's last error ahead of them. The labels
 * drop to their icons on a narrow bar — a container query, so this renders inside the bar.
 */
export function WorktreeActions({ worktree }: { worktree: Worktree }): React.JSX.Element {
  const env = worktree.environment
  const { openExternal } = usePlatform()
  const controls = useWorktreeControls(worktree)
  const primaryPort = controls.live ? primaryService(env.services)?.ports[0]?.port : undefined

  return (
    <div className="flex shrink-0 items-center justify-end gap-1">
      {controls.failure ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span role="alert" className="hidden max-w-56 truncate text-xs text-destructive @3xl:inline">
              {errorMessage(controls.failure)}
            </span>
          </TooltipTrigger>
          <TooltipContent>{errorMessage(controls.failure)}</TooltipContent>
        </Tooltip>
      ) : null}
      {primaryPort !== undefined ? (
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => openExternal(`http://localhost:${primaryPort}`)} aria-label={`Open localhost:${primaryPort} in the browser`}>
          <ExternalLink />
          <span className="hidden font-mono @6xl:inline">localhost:{primaryPort}</span>
        </Button>
      ) : null}
      {controls.startable ? (
        <Button size="sm" className="h-7 text-xs" onClick={controls.start} aria-label="Start the environment">
          <Play />
          <span className="hidden @3xl:inline">Start</span>
        </Button>
      ) : null}
      {controls.live ? (
        <>
          <Button variant="outline" size="sm" className="h-7 text-xs" disabled={controls.busy} onClick={controls.stop} aria-label="Stop the environment">
            <Square />
            <span className="hidden @3xl:inline">Stop</span>
          </Button>
          <Button variant="ghost" size="sm" className="h-7 text-xs" disabled={controls.busy} onClick={controls.restart} aria-label="Restart the environment">
            <RotateCw />
            <span className="hidden @6xl:inline">Restart</span>
          </Button>
        </>
      ) : null}
      {controls.busy ? (
        <span className="flex items-center gap-1.5 px-1 font-mono text-[11px] text-muted-foreground">
          <RotateCw className="size-3.5 animate-spin" />
          <span className="hidden @3xl:inline">{WORKTREE_BUSY_STATES.includes(env.state) ? `${env.state}…` : 'working…'}</span>
        </span>
      ) : null}
    </div>
  )
}

/**
 * A worktree's menu items: lifecycle, the configured editor and terminal, provisioning and the
 * env file, then destroy. Shared by every menu a worktree has, inside a `DropdownMenuContent`.
 */
export function WorktreeMenuItems({ worktree, onDestroy }: { worktree: Worktree; onDestroy: () => void }): React.JSX.Element {
  const env = worktree.environment
  const controls = useWorktreeControls(worktree)
  const { editor, terminal } = useToolLabels()
  return (
    <>
      {controls.startable ? <DropdownMenuItem onSelect={controls.start}>{env.state === 'none' ? 'Provision & start' : 'Start'}</DropdownMenuItem> : null}
      {controls.live ? (
        <>
          <DropdownMenuItem disabled={controls.busy} onSelect={controls.stop}>
            Stop
          </DropdownMenuItem>
          <DropdownMenuItem disabled={controls.busy} onSelect={controls.restart}>
            Restart
          </DropdownMenuItem>
        </>
      ) : null}
      {controls.startable || controls.live ? <DropdownMenuSeparator /> : null}
      <DropdownMenuItem onSelect={() => controls.openIn('editor')}>Open in {editor}</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => controls.openIn('terminal')}>Open in {terminal}</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={!env.configured || controls.busy} onSelect={controls.provision}>
        {controls.provisioned ? 'Re-run setup' : 'Provision'}
      </DropdownMenuItem>
      <DropdownMenuItem disabled={!env.configured || controls.regenerating} onSelect={controls.regenerate}>
        Regenerate {env.envFile ?? '.env.canopy'}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" disabled={worktree.isMain || controls.busy} onSelect={onDestroy}>
        Destroy worktree…
      </DropdownMenuItem>
    </>
  )
}
