import { useEffect, useState } from 'react'
import { RotateCw } from 'lucide-react'

import type { Worktree } from '@canopy/shared'

import { ErrorNote } from '@/components/error-note'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useDestroyWorktreeWith, useProjectSettings } from '@/lib/api-hooks'
import { plural } from '@/lib/format'
import { mergedLabel } from '@/lib/status'

/**
 * The last look before a worktree goes. Dirty files and an unmerged branch each get their own
 * line: the first is lost with the checkout, the second only if the branch goes too — so that
 * line turns red the moment "Delete branch" is ticked. A merged branch has nothing left to
 * lose, and the box starts ticked for it unless the project says branches are never deleted.
 */
export function DestroyWorktreeDialog({
  worktree,
  open,
  onOpenChange,
  onDestroyed
}: {
  worktree: Worktree
  open: boolean
  onOpenChange: (open: boolean) => void
  onDestroyed?: () => void
}): React.JSX.Element {
  const destroy = useDestroyWorktreeWith()
  const policy = useProjectSettings(worktree.projectId).data?.cleanup.deleteBranch
  const merged = mergedLabel(worktree)
  const [deleteBranch, setDeleteBranch] = useState(false)
  useEffect(() => {
    if (open) setDeleteBranch(merged?.merged === true && policy !== 'never')
    // Only the moment of opening sets the default; a later status refresh must not flip a choice.
  }, [open])
  const dirty = worktree.status?.dirtyTotal ?? 0
  const branch = worktree.branch

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Destroy {worktree.name}?</DialogTitle>
          <DialogDescription>
            Removes the worktree at <span className="font-mono">{worktree.path}</span>: this stops every service, frees its ports, and drops its database forks.
            {dirty > 0 ? (
              <span className="mt-2 block text-amber-600 dark:text-amber-500">
                This worktree has {plural(dirty, 'uncommitted change')}. They are saved as a commit under{' '}
                <span className="font-mono">refs/canopy/salvage/</span> first — <span className="font-mono">git for-each-ref refs/canopy/salvage</span> lists them, and{' '}
                <span className="font-mono">git restore --source=&lt;ref&gt; .</span> brings them back.
              </span>
            ) : null}
            {merged && !merged.merged && branch ? (
              <span className={`mt-2 block ${deleteBranch ? 'text-destructive' : 'text-amber-600 dark:text-amber-500'}`}>
                {merged.label}: branch <span className="font-mono">{branch}</span>
                {deleteBranch ? ' will be deleted and its commits discarded.' : ' is kept unless you delete it below.'}
              </span>
            ) : null}
            {merged?.disposable ? <span className="mt-2 block text-muted-foreground">{merged.label}.</span> : null}
          </DialogDescription>
        </DialogHeader>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={deleteBranch} disabled={worktree.isMain || !branch || destroy.isPending} onChange={(event) => setDeleteBranch(event.target.checked)} />
          <span>
            Delete branch <span className="font-mono">{branch ?? '(detached)'}</span>
          </span>
        </label>
        <ErrorNote error={destroy.error} />
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="sm" disabled={destroy.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            variant="destructive"
            size="sm"
            disabled={destroy.isPending}
            onClick={() =>
              destroy.mutate(
                { id: worktree.id, force: dirty > 0, deleteBranch },
                {
                  onSuccess: () => {
                    onOpenChange(false)
                    onDestroyed?.()
                  }
                }
              )
            }
          >
            {destroy.isPending ? <RotateCw className="animate-spin" /> : null}
            {destroy.isPending ? 'Destroying…' : 'Destroy worktree'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
