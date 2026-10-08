import { EyeOff, X } from 'lucide-react'
import { Popover } from 'radix-ui'

import type { HideMethod } from '@canopy/shared'

import { Button } from '@/components/ui/button'
import { PopoverSurface } from '@/components/ui/popover-surface'
import { useHidden, useUnhide } from '@/lib/api-hooks'
import { plural } from '@/lib/format'

/** Said in the popover, because the three mechanisms differ in ways that matter later. */
const EXPLANATION: Record<HideMethod, string> = {
  exclude: 'local to this repo, not committed',
  gitignore: 'in .gitignore, shared with everyone',
  skipWorktree: 'local edits ignored, this worktree only'
}

/**
 * A way back out of the right-click menu's hiding actions. Two of the three write files nobody
 * looks at (`.git/info/exclude`, the index's skip-worktree bits) and none of them leave a trace
 * in the file list, so without this they would be invisible and effectively permanent.
 */
export function HiddenPaths({ worktreeId }: { worktreeId: string }): React.JSX.Element | null {
  const hidden = useHidden(worktreeId).data ?? []
  const unhide = useUnhide(worktreeId)
  if (hidden.length === 0) return null

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button variant="ghost" size="sm" className="h-6 gap-1 px-1.5 font-mono text-[11px] text-muted-foreground">
          <EyeOff className="size-3" />
          {plural(hidden.length, 'path')} hidden
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content asChild side="top" align="start" sideOffset={6} collisionPadding={8}>
          <PopoverSurface className="z-50 w-[min(92vw,26rem)] p-2">
            <ul className="flex flex-col gap-0.5">
              {hidden.map((entry) => (
                <li key={`${entry.how}:${entry.path}`} className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-accent/50">
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={entry.path}>
                    {entry.path}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{EXPLANATION[entry.how]}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-5 shrink-0"
                    aria-label={`Stop hiding ${entry.path}`}
                    disabled={unhide.isPending}
                    onClick={() => unhide.mutate({ paths: [entry.path] })}
                  >
                    <X className="size-3" />
                  </Button>
                </li>
              ))}
            </ul>
          </PopoverSurface>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
