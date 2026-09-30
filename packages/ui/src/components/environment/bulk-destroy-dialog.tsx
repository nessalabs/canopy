import { useEffect, useState } from 'react'
import { RotateCw } from 'lucide-react'

import type { Worktree } from '@canopy/shared'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useBulkWorktreeAction, type BulkWorktreeResult } from '@/lib/api-hooks'
import { plural } from '@/lib/format'

const branches = (count: number): string => `${count} ${count === 1 ? 'branch' : 'branches'}`

/**
 * The last look before several worktrees go at once — the many-worktree form of
 * `DestroyWorktreeDialog`. Each row says what is at stake for that one. Uncommitted work is
 * saved as a salvage commit first, as a single destroy does. Only a branch git confirms is in
 * its base is ever deleted; an unmerged branch is always kept, whatever the checkbox says,
 * because a list is the wrong place to discard commits nobody looked at.
 */
export function BulkDestroyDialog({
  worktrees: offered,
  open,
  onOpenChange,
  onDone
}: {
  worktrees: Worktree[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: (result: BulkWorktreeResult) => void
}): React.JSX.Element {
  const bulk = useBulkWorktreeAction()
  const [deleteBranches, setDeleteBranches] = useState(true)
  const [finished, setFinished] = useState(0)
  const [failed, setFailed] = useState<BulkWorktreeResult['failed']>([])
  // The list is fixed when the dialog opens: each worktree turns "destroying" as the run reaches
  // it, and a list that followed the live selection would shrink under the progress count.
  const [worktrees, setWorktrees] = useState(offered)
  useEffect(() => {
    if (!open) return
    setWorktrees(offered)
    setDeleteBranches(true)
    setFinished(0)
    setFailed([])
    // Only the moment of opening resets the dialog; a status refresh must not.
  }, [open])

  const merged = worktrees.filter((wt) => wt.status?.merged === true && wt.branch)
  const unmerged = worktrees.filter((wt) => wt.branch && wt.status?.merged !== true)
  const dirty = worktrees.filter((wt) => (wt.status?.dirtyTotal ?? 0) > 0)
  const names = new Map(worktrees.map((wt) => [wt.id, wt.name]))

  const run = (): void => {
    const destroy = Object.fromEntries(
      worktrees.map((wt) => [wt.id, { force: (wt.status?.dirtyTotal ?? 0) > 0, deleteBranch: deleteBranches && wt.status?.merged === true && Boolean(wt.branch) }])
    )
    bulk.mutate(
      { ids: worktrees.map((wt) => wt.id), action: { destroy }, onEach: setFinished },
      {
        onSuccess: (result) => {
          setFailed(result.failed)
          onDone(result)
          if (result.failed.length === 0) onOpenChange(false)
        }
      }
    )
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (bulk.isPending ? undefined : onOpenChange(next))}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Destroy {plural(worktrees.length, 'worktree')}?</DialogTitle>
          <DialogDescription>
            Each one's services stop, its ports are freed, its database forks are dropped, and its checkout is removed.
            {dirty.length > 0 ? (
              <span className="mt-2 block text-amber-600 dark:text-amber-500">
                {plural(dirty.length, 'worktree')} {dirty.length === 1 ? 'has' : 'have'} uncommitted changes. Each is saved as a commit under{' '}
                <span className="font-mono">refs/canopy/salvage/</span> first.
              </span>
            ) : null}
            {unmerged.length > 0 ? (
              <span className="mt-2 block text-muted-foreground">
                {branches(unmerged.length)} {unmerged.length === 1 ? 'is' : 'are'} not confirmed merged and will be kept.
              </span>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        <ul className="flex max-h-56 flex-col divide-y divide-border overflow-y-auto rounded-lg border border-border">
          {worktrees.map((wt) => {
            const changes = wt.status?.dirtyTotal ?? 0
            return (
              <li key={wt.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                <span className="min-w-0 flex-1 truncate font-mono">{wt.name}</span>
                {changes > 0 ? <span className="shrink-0 text-amber-600 dark:text-amber-500">{plural(changes, 'change')} saved</span> : null}
                <span className="shrink-0 text-muted-foreground">{!wt.branch ? 'detached' : wt.status?.merged === true ? 'merged' : 'branch kept'}</span>
              </li>
            )
          })}
        </ul>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={deleteBranches} disabled={merged.length === 0 || bulk.isPending} onChange={(event) => setDeleteBranches(event.target.checked)} />
          <span>Delete the {merged.length === 1 ? 'merged branch' : `${merged.length} merged branches`} too</span>
        </label>
        {failed.length > 0 ? (
          <div role="alert" className="flex flex-col gap-1 text-xs text-destructive">
            <span>{plural(failed.length, 'worktree')} could not be destroyed:</span>
            {failed.map((failure) => (
              <span key={failure.id} className="font-mono">
                {names.get(failure.id) ?? failure.id}: {failure.message}
              </span>
            ))}
          </div>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="sm" disabled={bulk.isPending}>
              {failed.length > 0 ? 'Close' : 'Cancel'}
            </Button>
          </DialogClose>
          {failed.length === 0 ? (
            <Button variant="destructive" size="sm" disabled={bulk.isPending || worktrees.length === 0} onClick={run}>
              {bulk.isPending ? <RotateCw className="animate-spin" /> : null}
              {bulk.isPending ? `Destroying ${Math.min(finished + 1, worktrees.length)} of ${worktrees.length}…` : `Destroy ${plural(worktrees.length, 'worktree')}`}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
