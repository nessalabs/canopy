import { useEffect, useState } from 'react'
import { GitMerge, RotateCw } from 'lucide-react'

import type { MergeResult, MergeStrategy, Worktree } from '@canopy/shared'

import { DestroyWorktreeDialog } from '@/components/environment/destroy-worktree-dialog'
import { ErrorNote } from '@/components/error-note'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SegmentedControl, SegmentedControlOption } from '@/components/ui/segmented-control'
import { Textarea } from '@/components/ui/textarea'
import { useMergeWorktree } from '@/lib/api-hooks'
import { plural } from '@/lib/format'

const STRATEGY_HINT: Record<MergeStrategy, string> = {
  merge: 'Keeps every commit, under a merge commit that records the branch.',
  squash: 'One commit on the base with the message below; the branch history stays here.',
  ff: 'Moves the base to this branch. Only possible when the base has nothing this branch lacks.'
}

/**
 * Lands the worktree's branch on its base without leaving Canopy. The daemon runs the merge in
 * whichever checkout has the base — the primary one, usually — and undoes it if files clash, so
 * the worst case here is a list of files to resolve, never a half-merged main.
 *
 * Once landed, the natural next step is offered right here: the worktree has done its job.
 */
export function MergeDialog({ worktree, open, onOpenChange }: { worktree: Worktree; open: boolean; onOpenChange: (open: boolean) => void }): React.JSX.Element {
  const merge = useMergeWorktree(worktree.id)
  const [strategy, setStrategy] = useState<MergeStrategy>('merge')
  const [message, setMessage] = useState('')
  const [landed, setLanded] = useState<MergeResult>()
  const [destroyOpen, setDestroyOpen] = useState(false)

  const status = worktree.status
  const ahead = status?.ahead ?? 0
  const behind = status?.behind ?? 0
  const dirty = status?.dirtyTotal ?? 0
  const branch = worktree.branch ?? ''
  const base = worktree.baseBranch
  const canFastForward = behind === 0
  const defaultMessage = strategy === 'squash' ? (ahead === 1 && status?.lastCommit ? status.lastCommit.subject : branch) : ''

  useEffect(() => {
    if (!open) return
    setLanded(undefined)
    setMessage('')
    merge.reset()
    // A fresh opening starts from the plain merge, which is the one that cannot lose history.
    setStrategy('merge')
  }, [open])

  const land = (): void => {
    merge.mutate({ strategy, message: message.trim() || (strategy === 'squash' ? defaultMessage : undefined) }, { onSuccess: setLanded })
  }

  return (
    <>
      <Dialog open={open && !destroyOpen} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GitMerge className="size-4 text-muted-foreground" />
              {landed ? `Merged into ${base}` : `Merge ${branch} into ${base}?`}
            </DialogTitle>
            <DialogDescription>
              {landed ? (
                <>
                  {base} is now at <span className="font-mono">{landed.sha.slice(0, 7)}</span>
                  {landed.checkout ? (
                    <>
                      , in the checkout at <span className="font-mono">{landed.checkout}</span>
                    </>
                  ) : null}
                  . This worktree has done its job.
                </>
              ) : (
                <>
                  {plural(ahead, 'commit')} to land{behind > 0 ? `; ${base} has ${plural(behind, 'commit')} this branch lacks` : ''}.
                  {dirty > 0 ? <span className="mt-2 block text-amber-600 dark:text-amber-500">{plural(dirty, 'uncommitted change')} here will not be part of it — only commits merge.</span> : null}
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          {landed ? null : (
            <>
              <div className="flex flex-col gap-1.5">
                <SegmentedControl value={strategy} onValueChange={(value) => setStrategy(value as MergeStrategy)} aria-label="Merge strategy">
                  <SegmentedControlOption value="merge">Merge commit</SegmentedControlOption>
                  <SegmentedControlOption value="squash">Squash</SegmentedControlOption>
                  <SegmentedControlOption value="ff" disabled={!canFastForward}>
                    Fast-forward
                  </SegmentedControlOption>
                </SegmentedControl>
                <p className="text-xs text-muted-foreground">{STRATEGY_HINT[strategy]}</p>
              </div>
              {strategy !== 'ff' ? (
                <Textarea
                  className="min-h-16 font-mono text-xs"
                  placeholder={strategy === 'squash' ? defaultMessage : `Merge branch '${branch}' into ${base}`}
                  aria-label="Commit message"
                  value={message}
                  disabled={merge.isPending}
                  onChange={(event) => setMessage(event.target.value)}
                />
              ) : null}
              <ErrorNote error={merge.error} />
            </>
          )}

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="sm" disabled={merge.isPending}>
                {landed ? 'Close' : 'Cancel'}
              </Button>
            </DialogClose>
            {landed ? (
              <Button variant="destructive" size="sm" disabled={worktree.isMain} onClick={() => setDestroyOpen(true)}>
                Destroy worktree…
              </Button>
            ) : (
              <Button size="sm" disabled={merge.isPending || ahead === 0} onClick={land}>
                {merge.isPending ? <RotateCw className="animate-spin" /> : <GitMerge />}
                {merge.isPending ? 'Merging…' : `Merge into ${base}`}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DestroyWorktreeDialog
        worktree={worktree}
        open={destroyOpen}
        onOpenChange={(next) => {
          setDestroyOpen(next)
          if (!next) onOpenChange(false)
        }}
      />
    </>
  )
}
