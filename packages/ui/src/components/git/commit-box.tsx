import { useState } from 'react'

import type { ChangedFile, GitOperation } from '@canopy/shared'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useCommitChanges } from '@/lib/api-hooks'
import { plural } from '@/lib/format'

/** What a commit would carry: everything the index holds, whole files and part-staged alike. */
const stagedCount = (files: ChangedFile[]): number => files.filter((file) => file.staged !== 'unstaged').length

const OPERATION_NOTE: Record<GitOperation, string> = {
  merge: 'A merge is in progress. Resolve every conflict, then commit the merge.',
  rebase: 'A rebase is in progress. Finish or abort it from a terminal.',
  'cherry-pick': 'A cherry-pick is in progress. Resolve every conflict, then commit it.',
  revert: 'A revert is in progress. Resolve every conflict, then commit it.'
}

/**
 * Summary, description and the commit button, sitting under the file list the way GitHub
 * Desktop's does. There is no "which files" question to answer here: the checked boxes *are*
 * git's index, so this commits exactly what the list shows as checked.
 */
export function CommitBox({
  worktreeId,
  branch,
  files,
  operation
}: {
  worktreeId: string
  branch: string | null
  files: ChangedFile[]
  operation: GitOperation | null
}): React.JSX.Element {
  const commit = useCommitChanges(worktreeId)
  const [summary, setSummary] = useState('')
  const [description, setDescription] = useState('')
  const [committed, setCommitted] = useState<string>()

  const staged = stagedCount(files)
  const conflicted = files.filter((file) => file.conflicted).length
  const blocked = conflicted > 0 ? `Resolve ${plural(conflicted, 'conflict')} first` : staged === 0 ? 'Check at least one file' : undefined
  const ready = blocked === undefined && summary.trim() !== '' && !commit.isPending

  const submit = (): void => {
    if (!ready) return
    setCommitted(undefined)
    commit.mutate(
      { summary: summary.trim(), description: description.trim() || undefined, noVerify: false },
      {
        onSuccess: (created) => {
          setSummary('')
          setDescription('')
          setCommitted(created.shortSha)
        }
      }
    )
  }

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-border bg-card px-3 py-2">
      {operation ? <p className="text-[11px] text-amber-600 dark:text-amber-500">{OPERATION_NOTE[operation]}</p> : null}
      <Input
        value={summary}
        onChange={(event) => setSummary(event.target.value)}
        placeholder="Summary (required)"
        aria-label="Commit summary"
        className="h-8 text-xs"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit()
        }}
      />
      <Textarea
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        placeholder="Description"
        aria-label="Commit description"
        className="min-h-14 text-xs"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit()
        }}
      />
      {commit.error ? <p className="max-h-24 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-destructive">{commit.error.message}</p> : null}
      {committed ? <p className="font-mono text-[11px] text-muted-foreground">Committed {committed}.</p> : null}
      <Button size="sm" className="h-8 w-full" disabled={!ready} title={blocked} onClick={submit}>
        {commit.isPending ? 'Committing…' : `Commit ${staged > 0 ? staged : ''} to ${branch ?? 'a detached HEAD'}`}
      </Button>
    </div>
  )
}
