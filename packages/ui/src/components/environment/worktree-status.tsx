import { useState } from 'react'
import { ArrowDown, ArrowUp, Check, Copy, GitBranch, Maximize2, Minimize2, ScrollText, Sparkles, SquareTerminal, Upload } from 'lucide-react'
import { Popover } from 'radix-ui'
import { useLocation } from 'wouter'

import { environmentDot, PROVISION_LOG, type Worktree } from '@canopy/shared'

import { ErrorNote } from '@/components/error-note'
import { IconAction } from '@/components/icon-action'
import { ShellSlot } from '@/components/shell-slots'
import { StatusPopover, StatusRow } from '@/components/status-bar'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { StatusDot } from '@/components/ui/status-dot'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useProjects, usePushBranch, useWorktree, useWorktrees } from '@/lib/api-hooks'
import { uptime } from '@/lib/environment-ui'
import { plural } from '@/lib/format'
import { ENV_STATE_BADGE, mergedLabel, WORKTREE_DOT } from '@/lib/status'

import { DestroyWorktreeDialog } from './destroy-worktree-dialog'
import { LogsPanel } from './logs-panel'
import { useToolLabels, useWorktreeControls, WorktreeMenuItems } from './worktree-actions'

const TRIGGER = 'h-6 gap-1.5 px-1.5 font-mono text-xs font-normal text-muted-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground'

/** The dot the sidebar shows for a worktree: its checkout's state until an environment exists. */
const dotOf = (worktree: Worktree) => (worktree.environment.state === 'none' ? WORKTREE_DOT[worktree.state] : environmentDot(worktree.environment))

/** The worktree's facts, then its siblings to switch to, then everything that can be done to it. */
function BranchMenu({ worktree, projectName, onDestroy }: { worktree: Worktree; projectName: string; onDestroy: () => void }): React.JSX.Element {
  const [, navigate] = useLocation()
  const [copied, setCopied] = useState(false)
  const siblings = (useWorktrees().data ?? []).filter((wt) => wt.projectId === worktree.projectId)
  const env = worktree.environment
  const status = worktree.status
  const merged = mergedLabel(worktree)
  const up = uptime(env.startedAt)
  const name = worktree.isMain ? (worktree.branch ?? worktree.name) : worktree.name

  const copyPath = (): void => {
    void navigator.clipboard?.writeText(worktree.path).catch(() => undefined)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className={`${TRIGGER} min-w-0 text-foreground`} aria-label={`Worktree ${name}`}>
          <StatusDot status={dotOf(worktree)} aria-label={ENV_STATE_BADGE[env.state].label} />
          <GitBranch className="size-3" />
          <span className="truncate">{name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-80">
        <div className="flex flex-col gap-1 px-2 py-1.5">
          <StatusRow label="State">{ENV_STATE_BADGE[env.state].label}</StatusRow>
          <StatusRow label="Project">{projectName}</StatusRow>
          <StatusRow label="Branch">{worktree.branch ?? 'detached'}</StatusRow>
          <StatusRow label="Base">{worktree.baseBranch}</StatusRow>
          {merged ? <StatusRow label="Merged">{merged.merged ? 'yes' : 'no'}</StatusRow> : null}
          {up ? <StatusRow label="Uptime">{up}</StatusRow> : null}
          {status?.lastCommit ? <StatusRow label="Last commit">{status.lastCommit.subject}</StatusRow> : null}
        </div>
        {/* Held open so the copy reports back where it was asked for. */}
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault()
            copyPath()
          }}
        >
          {copied ? <Check /> : <Copy />}
          <span className="min-w-0 truncate font-mono text-xs">{copied ? 'Copied' : worktree.path}</span>
        </DropdownMenuItem>
        {siblings.length > 1 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Worktrees</DropdownMenuLabel>
            {siblings.map((wt) => (
              <DropdownMenuItem key={wt.id} onSelect={() => navigate(`/worktrees/${wt.id}`)}>
                <StatusDot status={dotOf(wt)} />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{wt.isMain ? (wt.branch ?? wt.name) : wt.name}</span>
                {wt.id === worktree.id ? <span className="text-[10px] text-muted-foreground">current</span> : null}
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
        <DropdownMenuSeparator />
        <WorktreeMenuItems worktree={worktree} onDestroy={onDestroy} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Ahead and behind the base, and the push that sends the branch's commits up. */
function Sync({ worktree }: { worktree: Worktree }): React.JSX.Element | null {
  const push = usePushBranch(worktree.id)
  const status = worktree.status
  // Null is git declining to compare: the base is not a branch here.
  if (status?.ahead === null || status?.ahead === undefined) return null
  return (
    <StatusPopover
      label={`${status.ahead} ahead, ${status.behind} behind ${worktree.baseBranch}`}
      className="w-72"
      trigger={
        <span className="flex items-center gap-0.5">
          <ArrowUp className="size-3" />
          {status.ahead}
          <ArrowDown className="ml-1 size-3" />
          {status.behind}
        </span>
      }
    >
      <div className="flex flex-col gap-2.5 p-3">
        <p className="text-sm">
          {plural(status.ahead, 'commit')} ahead, {status.behind} behind <span className="font-mono">{worktree.baseBranch}</span>
        </p>
        <Button size="sm" variant="outline" className="w-fit" disabled={push.isPending || worktree.branch === null} onClick={() => push.mutate()}>
          <Upload />
          {push.isPending ? 'Pushing…' : `Push ${worktree.branch ?? 'branch'}`}
        </Button>
        <ErrorNote error={push.error} />
      </div>
    </StatusPopover>
  )
}

/**
 * The open worktree's half of the status bar: which worktree and branch, how it stands against
 * its base, and what is uncommitted — each one a way in to more (its menu, a push, the diff).
 */
export function WorktreeStatus({
  worktree,
  projectName,
  onDestroy,
  onOpenChanges
}: {
  worktree: Worktree
  projectName: string
  onDestroy: () => void
  onOpenChanges: () => void
}): React.JSX.Element {
  const dirty = worktree.status?.dirtyTotal ?? 0
  const reason = worktree.environment.stateReason
  return (
    <>
      <BranchMenu worktree={worktree} projectName={projectName} onDestroy={onDestroy} />
      <Sync worktree={worktree} />
      <Button variant="ghost" size="sm" className={TRIGGER} onClick={onOpenChanges}>
        {dirty ? plural(dirty, 'changed file') : 'Clean'}
      </Button>
      {reason ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="min-w-0 truncate px-1.5 text-[11px] text-destructive">{reason}</span>
          </TooltipTrigger>
          <TooltipContent>{reason}</TooltipContent>
        </Tooltip>
      ) : null}
    </>
  )
}

/** The two sizes the logs popover comes in: a glance, and most of the window. */
const LOG_SIZES = { compact: 'h-72 w-[min(92vw,30rem)]', large: 'h-[70vh] w-[min(92vw,64rem)]' } as const

/** The worktree's live logs, a step from wherever the reader is — larger on demand, or in full in Environment. */
function LogsPopover({ worktree, onOpenEnvironment }: { worktree: Worktree; onOpenEnvironment: () => void }): React.JSX.Element {
  const [service, setService] = useState(PROVISION_LOG)
  const [size, setSize] = useState<keyof typeof LOG_SIZES>('compact')
  const large = size === 'large'
  return (
    <StatusPopover label="Logs" align="end" className={`flex flex-col ${LOG_SIZES[size]}`} trigger={<ScrollText className="size-3.5" />}>
      <div className="flex items-center gap-1 border-b border-border py-1 ps-3 pe-1 text-sm font-medium">
        <span className="flex-1">Logs</span>
        <Popover.Close asChild>
          <Button variant="ghost" size="sm" className="h-6 text-xs font-normal text-muted-foreground" onClick={onOpenEnvironment}>
            Open in Environment
          </Button>
        </Popover.Close>
        <IconAction label={large ? 'Smaller' : 'Larger'} onClick={() => setSize(large ? 'compact' : 'large')}>
          {large ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </IconAction>
      </div>
      <div className="min-h-0 flex-1">
        <LogsPanel worktree={worktree} service={service} onServiceChange={setService} />
      </div>
    </StatusPopover>
  )
}

/** The status bar's right-hand worktree tools: its logs, a terminal in it, and its agent. */
export function WorktreeStatusTools({ worktree, onOpenEnvironment, onOpenAgent }: { worktree: Worktree; onOpenEnvironment: () => void; onOpenAgent: () => void }): React.JSX.Element {
  const controls = useWorktreeControls(worktree)
  const { terminal } = useToolLabels()
  return (
    <>
      <IconAction label={`Open in ${terminal}`} className="w-7" onClick={() => controls.openIn('terminal')}>
        <SquareTerminal className="size-3.5" />
      </IconAction>
      <LogsPopover worktree={worktree} onOpenEnvironment={onOpenEnvironment} />
      <IconAction label="Agent  3" className="w-7" onClick={onOpenAgent}>
        <Sparkles className="size-3.5" />
      </IconAction>
    </>
  )
}

/**
 * The status bar away from a worktree — Preferences, the Command Center — keeps showing the last
 * worktree that was open, so its logs and terminal stay a click away. Anything that means a
 * section of the worktree goes back to it, opened on that section.
 */
export function RecentWorktreeStatus({ id }: { id: string }): React.JSX.Element | null {
  const [, navigate] = useLocation()
  const [destroyOpen, setDestroyOpen] = useState(false)
  const worktree = useWorktree(id).data
  const projectName = useProjects().data?.find((p) => p.id === worktree?.projectId)?.name ?? ''
  if (!worktree) return null
  const go = (query: string) => () => navigate(`/worktrees/${id}?${query}`)
  return (
    <>
      <ShellSlot name="status">
        <WorktreeStatus worktree={worktree} projectName={projectName} onDestroy={() => setDestroyOpen(true)} onOpenChanges={go('tab=git&pane=changes')} />
      </ShellSlot>
      <ShellSlot name="statusEnd">
        <WorktreeStatusTools worktree={worktree} onOpenEnvironment={go('tab=environment')} onOpenAgent={go('tab=agent')} />
      </ShellSlot>
      <DestroyWorktreeDialog worktree={worktree} open={destroyOpen} onOpenChange={setDestroyOpen} onDestroyed={() => navigate('/')} />
    </>
  )
}
