/**
 * The trash: worktrees destroyed while they still held uncommitted work. Canopy saves that
 * work as a commit before the checkout goes, and this is where it can be looked at and put
 * back — otherwise the rescue is only reachable by knowing `git for-each-ref` off by heart.
 *
 * Restoring recreates the worktree the way it was, with the work uncommitted, and takes the
 * entry out of the trash; it is the only route out, because a snapshot nobody can act on is
 * no better than the loss it was saving you from.
 */
import { useState } from 'react'
import { RotateCcw, RotateCw, Trash2 } from 'lucide-react'
import { useLocation } from 'wouter'

import type { TrashEntry } from '@canopy/shared'

import { ErrorNote } from '@/components/error-note'
import { Button } from '@/components/ui/button'
import { usePurgeFromTrash, useProjectTrash, useRestoreFromTrash } from '@/lib/api-hooks'
import { plural, relativeTime } from '@/lib/format'

function Entry({ entry, projectId }: { entry: TrashEntry; projectId: string }): React.JSX.Element {
  const [, navigate] = useLocation()
  const restore = useRestoreFromTrash(projectId)
  const purge = usePurgeFromTrash(projectId)
  const [confirming, setConfirming] = useState(false)
  const busy = restore.isPending || purge.isPending

  return (
    <li className="flex flex-col gap-2 border-b border-border py-3 last:border-b-0">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-mono text-sm">{entry.name}</span>
          <span className="truncate text-xs text-muted-foreground">
            {entry.branch ?? 'detached'} · {plural(entry.files, 'file')} · destroyed {relativeTime(entry.destroyedAt)}
          </span>
        </div>
        {confirming ? (
          <>
            <span className="text-xs text-muted-foreground">Delete for good?</span>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" disabled={busy} onClick={() => purge.mutate(entry.id, { onSuccess: () => setConfirming(false) })}>
              Delete
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => restore.mutate(entry.id, { onSuccess: (result) => navigate(`/worktrees/${result.worktree.id}`) })}
            >
              {restore.isPending ? <RotateCw className="animate-spin" /> : <RotateCcw />}
              {restore.isPending ? 'Restoring…' : 'Restore'}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} aria-label={`Delete ${entry.name} for good`} onClick={() => setConfirming(true)}>
              <Trash2 />
            </Button>
          </>
        )}
      </div>
      <ErrorNote error={restore.error ?? purge.error} />
    </li>
  )
}

/** Trash tab. */
export function TrashTab({ projectId }: { projectId: string }): React.JSX.Element {
  const trash = useProjectTrash(projectId)
  const entries = trash.data ?? []

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">Trash</h2>
        <p className="text-sm text-muted-foreground">
          Destroying a worktree that still had uncommitted changes saves them here first. Restoring brings the worktree back — same path, same branch, the work still
          uncommitted.
        </p>
      </div>

      {trash.isPending ? (
        <p className="text-sm text-muted-foreground">Reading the trash…</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing here. Worktrees destroyed with no uncommitted work leave nothing behind to restore.</p>
      ) : (
        <ul className="flex flex-col">
          {entries.map((entry) => (
            <Entry key={entry.id} entry={entry} projectId={projectId} />
          ))}
        </ul>
      )}
      <ErrorNote error={trash.error} />
    </div>
  )
}
