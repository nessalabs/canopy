import { ExternalLink, MoreHorizontal, Play, RotateCw, Square } from 'lucide-react'

import { EDITOR_PRESETS, TERMINAL_PRESETS, isLive, primaryService, type EditorId, type OpenInput, type TerminalId, type Worktree } from '@canopy/shared'

import { errorMessage } from '@/components/error-note'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppSettings, useOpenWorktree, useProvisionWorktree, useRegenerateEnvFile, useWorktreeLifecycle } from '@/lib/api-hooks'
import { usePlatform } from '@/providers/platform'

/** States in which a lifecycle command is already in flight; every button waits it out. */
const BUSY = ['creating', 'provisioning', 'starting', 'stopping', 'destroying']

const label = (presets: Record<string, { label: string }>, id: string, fallback: string): string => (id === 'custom' ? fallback : (presets[id]?.label ?? fallback))

/**
 * Start / Stop / Restart, the primary service's URL, and the overflow menu (open in the
 * configured editor or terminal, re-provision, regenerate the env file, destroy). Every
 * action reports its own pending state and surfaces the daemon's error inline.
 *
 * It shares one row with the worktree's identity and tab strip, so the labels drop to their
 * icons on a narrow row. That collapse is a container query: render this inside an
 * `@container` ancestor, or the labels simply stay on.
 */
export function WorktreeActions({ worktree, onDestroy }: { worktree: Worktree; onDestroy: () => void }): React.JSX.Element {
  const env = worktree.environment
  const { openExternal } = usePlatform()
  const settings = useAppSettings().data
  const lifecycle = useWorktreeLifecycle(worktree.id)
  const provision = useProvisionWorktree(worktree.id)
  const regenerate = useRegenerateEnvFile(worktree.id)
  const open = useOpenWorktree(worktree.id)

  const busy = BUSY.includes(env.state) || lifecycle.isPending || provision.isPending
  const live = isLive(env.state)
  const provisioned = env.state !== 'none'
  const startable = !busy && (env.state === 'stopped' || env.state === 'error' || (env.state === 'none' && env.configured))
  const primary = live ? primaryService(env.services) : undefined
  const primaryPort = primary?.ports[0]?.port
  const failure = lifecycle.error ?? provision.error ?? regenerate.error ?? open.error
  const editor = label(EDITOR_PRESETS as Record<EditorId, { label: string }>, settings?.editor.id ?? 'custom', 'editor')
  const terminal = label(TERMINAL_PRESETS as Record<TerminalId, { label: string }>, settings?.terminal.id ?? 'custom', 'terminal')

  const start = (): void => {
    if (env.state === 'none') provision.mutate({ autoStart: true })
    else lifecycle.mutate('start')
  }
  const launch = (target: OpenInput['target']): void => {
    open.mutate({ target })
  }

  return (
    <div className="flex shrink-0 items-center justify-end gap-1.5">
      {failure ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span role="alert" className="hidden max-w-56 truncate text-xs text-destructive @3xl:inline">
              {errorMessage(failure)}
            </span>
          </TooltipTrigger>
          <TooltipContent>{errorMessage(failure)}</TooltipContent>
        </Tooltip>
      ) : null}
      {primaryPort !== undefined ? (
        <Button variant="outline" size="sm" className="h-8" onClick={() => openExternal(`http://localhost:${primaryPort}`)} aria-label={`Open localhost:${primaryPort} in the browser`}>
          <ExternalLink />
          <span className="hidden font-mono @6xl:inline">localhost:{primaryPort}</span>
        </Button>
      ) : null}
      {startable ? (
        <Button size="sm" className="h-8" onClick={start} aria-label="Start the environment">
          <Play />
          <span className="hidden @3xl:inline">Start</span>
        </Button>
      ) : null}
      {live ? (
        <>
          <Button variant="outline" size="sm" className="h-8" disabled={busy} onClick={() => lifecycle.mutate('stop')} aria-label="Stop the environment">
            <Square />
            <span className="hidden @3xl:inline">Stop</span>
          </Button>
          <Button variant="ghost" size="sm" className="h-8" disabled={busy} onClick={() => lifecycle.mutate('restart')} aria-label="Restart the environment">
            <RotateCw />
            <span className="hidden @6xl:inline">Restart</span>
          </Button>
        </>
      ) : null}
      {busy ? (
        <span className="flex items-center gap-1.5 px-1 font-mono text-[11px] text-muted-foreground">
          <RotateCw className="size-3.5 animate-spin" />
          <span className="hidden @3xl:inline">{BUSY.includes(env.state) ? `${env.state}…` : 'working…'}</span>
        </span>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8" aria-label="More actions">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => launch('editor')}>Open in {editor}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => launch('terminal')}>Open in {terminal}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!env.configured || busy} onSelect={() => provision.mutate(provisioned ? { from: 'run-setup' } : {})}>
            {provisioned ? 'Re-run setup' : 'Provision'}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!env.configured || regenerate.isPending} onSelect={() => regenerate.mutate()}>
            Regenerate {env.envFile ?? '.env.canopy'}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" disabled={worktree.isMain} onSelect={onDestroy}>
            Destroy worktree…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
