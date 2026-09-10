/** Destructive project actions: stop everything, destroy every worktree, forget the project. */
import { useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { useLocation } from 'wouter'

import type { Project } from '@canopy/shared'

import { ErrorNote } from '@/components/error-note'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useDestroyAllWorktrees, useRemoveProject, useStopAllWorktrees, useWorktrees } from '@/lib/api-hooks'
import { plural } from '@/lib/format'

import { TabHeader } from './settings-chrome'

/** Danger zone tab. */
export function DangerTab({ project }: { project: Project }): React.JSX.Element {
  const [, navigate] = useLocation()
  const worktrees = (useWorktrees().data ?? []).filter((worktree) => worktree.projectId === project.id && !worktree.isMain)
  const stopAll = useStopAllWorktrees(project.id)
  const destroyAll = useDestroyAllWorktrees(project.id)
  const remove = useRemoveProject()

  const [confirm, setConfirm] = useState('')
  const [deleteBranch, setDeleteBranch] = useState(false)
  const dirty = worktrees.filter((worktree) => (worktree.status?.dirtyTotal ?? 0) > 0).length

  return (
    <div className="flex flex-col gap-3">
      <TabHeader title="Danger zone" description="These act on every worktree of this project at once." />

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-sm">Stop all services</CardTitle>
          <CardDescription>Stops every running worktree of this project. Ports stay allocated, databases stay forked, nothing is deleted.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <ErrorNote error={stopAll.error} />
          <div>
            <Button variant="outline" size="sm" disabled={stopAll.isPending} onClick={() => stopAll.mutate(undefined)}>
              {stopAll.isPending ? 'Stopping…' : 'Stop all'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-sm">Destroy all worktrees</CardTitle>
          <CardDescription>
            Removes {plural(worktrees.length, 'worktree')} with their ports, database forks and runtime data. The primary checkout is untouched.
            {dirty > 0 ? ` ${dirty} of them ${dirty === 1 ? 'has' : 'have'} uncommitted changes.` : ''}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <ErrorNote error={destroyAll.error} />
          <Dialog onOpenChange={() => setConfirm('')}>
            <DialogTrigger asChild>
              <Button variant="destructive" size="sm" disabled={worktrees.length === 0 || destroyAll.isPending}>
                <TriangleAlert /> Destroy all
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Destroy all worktrees of {project.name}?</DialogTitle>
                <DialogDescription>
                  Type <span className="font-mono">{project.name}</span> to confirm.
                  {dirty > 0 ? (
                    <span className="mt-2 block text-destructive">
                      {dirty} worktree{dirty === 1 ? ' has' : 's have'} uncommitted changes that will be lost.
                    </span>
                  ) : null}
                </DialogDescription>
              </DialogHeader>
              <Input value={confirm} onChange={(event) => setConfirm(event.target.value)} className="font-mono" aria-label="Type the project name to confirm" />
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={deleteBranch} aria-label="Delete the branches too" onChange={(event) => setDeleteBranch(event.currentTarget.checked)} />
                Delete their branches too
              </label>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="ghost" size="sm">
                    Cancel
                  </Button>
                </DialogClose>
                <DialogClose asChild>
                  <Button variant="destructive" size="sm" disabled={confirm !== project.name} onClick={() => destroyAll.mutate({ force: true, deleteBranch })}>
                    Destroy all worktrees
                  </Button>
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardContent>
      </Card>

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-sm">Unregister project</CardTitle>
          <CardDescription>Canopy forgets {project.name}, its settings and its review comments. Nothing on disk is touched — worktrees and branches stay where they are.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <ErrorNote error={remove.error} />
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="destructive" size="sm" disabled={remove.isPending}>
                Unregister
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Unregister {project.name}?</DialogTitle>
                <DialogDescription>The repository itself is untouched. Add it again any time and Canopy re-reads its canopy.yaml.</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="ghost" size="sm">
                    Cancel
                  </Button>
                </DialogClose>
                <DialogClose asChild>
                  <Button variant="destructive" size="sm" onClick={() => remove.mutate(project.id, { onSuccess: () => navigate('/') })}>
                    Unregister
                  </Button>
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardContent>
      </Card>
    </div>
  )
}
