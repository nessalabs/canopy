import { useEffect, useState } from 'react'
import { RotateCw, Undo2 } from 'lucide-react'

import type { RewindInput, RewindResult, SessionRef } from '@canopy/shared'

import { ErrorNote } from '@/components/error-note'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useRewindFiles } from '@/lib/api-hooks'
import { LATER_TURNS_NOTE, SOURCE_NOTE, filePreview, lineCounts } from '@/lib/rewind'

/**
 * Confirms putting one turn's files back. The dry run is what fills the dialog: the daemon reports
 * which mechanism it would use and every path it would touch, so the reader decides against the
 * real list rather than against the turn's own file list, which a later turn may have moved on.
 */
export function RewindDialog({
  worktreeId,
  session,
  input,
  prompt,
  open,
  onOpenChange,
  onRewound
}: {
  worktreeId: string
  /** The session the turn belongs to; without it there is nothing to address. */
  session: SessionRef | undefined
  /** What the rewind is addressed by, or null when this turn cannot be rewound. */
  input: RewindInput | null
  /** The turn's prompt, so the dialog names the message it is rewinding to. */
  prompt: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onRewound: (result: RewindResult) => void
}): React.JSX.Element {
  const preview = useRewindFiles(worktreeId, session)
  const apply = useRewindFiles(worktreeId, session)
  const [plan, setPlan] = useState<RewindResult>()

  // Every opening asks again: files move under a turn, and a stale plan would confirm the wrong thing.
  useEffect(() => {
    if (!open || !input) return
    setPlan(undefined)
    preview.reset()
    apply.reset()
    preview.mutate({ ...input, dryRun: true }, { onSuccess: setPlan })
  }, [open, input?.messageId, input?.tree])

  const files = filePreview(plan?.filesChanged ?? [])
  const counts = plan ? lineCounts(plan) : undefined
  const ready = plan?.canRewind === true

  const run = (): void => {
    if (!input) return
    apply.mutate(input, {
      onSuccess: (result) => {
        onRewound(result)
        onOpenChange(false)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Undo2 className="size-4 text-muted-foreground" />
            Rewind files to before this message?
          </DialogTitle>
          <DialogDescription className="line-clamp-3 whitespace-pre-wrap" title={prompt}>
            {prompt || 'This turn'}
          </DialogDescription>
        </DialogHeader>

        {preview.isPending ? <p className="m-0 text-xs text-muted-foreground">Working out what would change…</p> : null}
        <ErrorNote error={preview.error ?? apply.error} />
        {plan && !plan.canRewind ? <p className="m-0 text-xs text-destructive">{plan.error ?? 'This turn cannot be rewound.'}</p> : null}

        {ready ? (
          <div className="flex flex-col gap-2">
            <p className="m-0 text-xs text-muted-foreground">{SOURCE_NOTE[plan.source]}</p>
            {plan.filesChanged.length === 0 ? (
              <p className="m-0 text-xs text-muted-foreground">Nothing differs from that point — no file would change.</p>
            ) : (
              <>
                <div className="max-h-52 overflow-y-auto rounded-md border border-border p-2">
                  <ul className="m-0 list-none p-0 font-mono text-[11px]">
                    {files.shown.map((file) => (
                      <li key={file} className="truncate" title={file}>
                        {file}
                      </li>
                    ))}
                  </ul>
                  {files.more > 0 ? <p className="m-0 mt-1 text-[11px] text-muted-foreground">+{files.more} more</p> : null}
                </div>
                <p className="m-0 text-xs text-muted-foreground">
                  {plan.filesChanged.length} file{plan.filesChanged.length === 1 ? '' : 's'}
                  {counts ? <span className="ml-2 font-mono">{counts}</span> : null}
                </p>
              </>
            )}
            <p className="m-0 text-xs text-amber-600 dark:text-amber-500">{LATER_TURNS_NOTE}</p>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" size="sm" disabled={apply.isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {ready ? (
            <Button variant="destructive" size="sm" disabled={apply.isPending} onClick={run}>
              {apply.isPending ? <RotateCw className="animate-spin" /> : <Undo2 />}
              {apply.isPending ? 'Rewinding…' : 'Rewind'}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
