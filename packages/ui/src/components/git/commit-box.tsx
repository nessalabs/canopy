import { useRef, useState } from 'react'

import type { ChangedFile, GitOperation } from '@canopy/shared'

import { ErrorNote } from '@/components/error-note'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useCommitChanges } from '@/lib/api-hooks'
import { useDraftJob } from '@/lib/draft-jobs'
import { plural } from '@/lib/format'

import { DraftButton } from './draft-button'
import { commitFormId } from './git-chrome'

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
  const summaryRef = useRef<HTMLInputElement>(null)
  // Keeps running while the user is in another worktree; the result waits here for their return.
  const drafting = useDraftJob(worktreeId, 'commit', (draft) => {
    setSummary(draft.title)
    setDescription(draft.body)
  })

  const staged = stagedCount(files)
  const conflicted = files.filter((file) => file.conflicted).length
  const blocked = conflicted > 0 ? `Resolve ${plural(conflicted, 'conflict')} first` : staged === 0 ? 'Check at least one file' : undefined
  const ready = blocked === undefined && summary.trim() !== '' && !commit.isPending && !drafting.running

  const submit = (): void => {
    if (!ready) return
    setCommitted(undefined)
    commit.mutate(
      { summary: summary.trim(), description: description.trim() || undefined, noVerify: false },
      {
        onSuccess: (created) => {
          drafting.dismiss()
          setSummary('')
          setDescription('')
          setCommitted(created.shortSha)
        }
      }
    )
  }

  // A form so the top bar's Commit can submit it from outside; with no summary yet, that
  // click is a request to write one, so it lands in the field instead.
  return (
    <form
      id={commitFormId(worktreeId)}
      className="flex shrink-0 flex-col gap-2 border-t border-border bg-card px-3 py-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (summary.trim() === '') summaryRef.current?.focus()
        else submit()
      }}
    >
      {operation ? <p className="text-[11px] text-amber-600 dark:text-amber-500">{OPERATION_NOTE[operation]}</p> : null}
      <div className="flex gap-2">
        <Input
          ref={summaryRef}
          value={summary}
          disabled={drafting.running}
          onChange={(event) => setSummary(event.target.value)}
          placeholder={drafting.running ? 'Drafting…' : 'Summary (required)'}
          aria-label="Commit summary"
          className="h-8 text-xs"
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            // Plain Enter would submit the form; committing stays a deliberate ⌘/Ctrl+Enter.
            event.preventDefault()
            if (event.metaKey || event.ctrlKey) submit()
          }}
        />
        <DraftButton compact running={drafting.running} blocked={blocked} onClick={() => drafting.start({ kind: 'commit' })} />
      </div>
      <Textarea
        value={description}
        disabled={drafting.running}
        onChange={(event) => setDescription(event.target.value)}
        placeholder="Description"
        aria-label="Commit description"
        className="min-h-14 text-xs"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit()
        }}
      />
      <ErrorNote error={drafting.error} />
      {commit.error ? <p className="max-h-24 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-destructive">{commit.error.message}</p> : null}
      {committed ? <p className="font-mono text-[11px] text-muted-foreground">Committed {committed}.</p> : null}
      <Button type="submit" size="sm" className="h-8 w-full" disabled={!ready} title={blocked}>
        {commit.isPending ? 'Committing…' : `Commit ${staged > 0 ? staged : ''} to ${branch ?? 'a detached HEAD'}`}
      </Button>
    </form>
  )
}
