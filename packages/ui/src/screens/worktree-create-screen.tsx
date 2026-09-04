import { useState } from 'react'
import { GitBranch } from 'lucide-react'
import { useLocation } from 'wouter'

import { WORKTREE_NAME_PATTERN, type BranchSpec } from '@canopy/shared'

import { ErrorNote } from '@/components/error-note'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { SearchableListbox } from '@/components/ui/searchable-listbox'
import { SegmentedControl, SegmentedControlOption } from '@/components/ui/segmented-control'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useBranches, useCreateWorktree, useProjects } from '@/lib/api-hooks'

/** Suggests a worktree slug from a branch name (last path segment, slugified). */
const suggestName = (branch: string): string =>
  (branch.split('/').pop() ?? branch).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')

export function WorktreeCreateScreen({ projectId }: { projectId: string }): React.JSX.Element {
  const [, navigate] = useLocation()
  const project = useProjects().data?.find((p) => p.id === projectId)
  const branches = useBranches(projectId)
  const create = useCreateWorktree(projectId)

  const [mode, setMode] = useState<BranchSpec['mode']>('new')
  const [newBranch, setNewBranch] = useState('')
  const [base, setBase] = useState<string>()
  const [existing, setExisting] = useState<string>()
  const [name, setName] = useState<string>()

  const baseBranch = base ?? branches.data?.defaultBranch ?? project?.defaultBase ?? 'main'
  const branchName = mode === 'new' ? newBranch.trim() : existing ?? ''
  const effectiveName = name ?? suggestName(branchName)
  const valid = branchName !== '' && WORKTREE_NAME_PATTERN.test(effectiveName)
  const branch: BranchSpec = mode === 'new' ? { mode, name: branchName, base: baseBranch } : { mode, name: branchName }

  if (!project) return <p className="p-6 text-sm text-muted-foreground">Project not found.</p>

  return (
    <form
      className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-6 py-6"
      onSubmit={(event) => {
        event.preventDefault()
        create.mutate({ name: effectiveName, branch }, { onSuccess: (worktree) => navigate(`/worktrees/${worktree.id}`) })
      }}
    >
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          New worktree <span className="font-mono text-muted-foreground">· {project.name}</span>
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">Checks the branch out into its own directory under the daemon's worktree root. Services and databases come later.</p>
      </div>
      <Card>
        <CardContent className="flex flex-col gap-5 pt-6">
          <div className="flex flex-col gap-2">
            <SegmentedControl value={mode} onValueChange={(value) => setMode(value as BranchSpec['mode'])} aria-label="Branch mode">
              <SegmentedControlOption value="new">New branch</SegmentedControlOption>
              <SegmentedControlOption value="existing">Existing branch</SegmentedControlOption>
            </SegmentedControl>
            {mode === 'new' ? (
              <div className="flex flex-col gap-2">
                <Input aria-label="New branch name" placeholder="feat/my-feature" className="font-mono" value={newBranch} onChange={(event) => setNewBranch(event.target.value)} autoFocus />
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <GitBranch className="size-3" /> from
                  </span>
                  <Select value={baseBranch} onValueChange={setBase}>
                    <SelectTrigger className="w-64 font-mono" aria-label="Base branch">
                      <SelectValue placeholder="Base branch" />
                    </SelectTrigger>
                    <SelectContent>
                      {(branches.data?.branches ?? []).map((b) => (
                        <SelectItem key={b.name} value={b.name} className="font-mono">
                          {b.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ) : (
              <SearchableListbox
                items={branches.data?.branches ?? []}
                getItemId={(item) => item.name}
                getItemKeywords={(item) => [item.name]}
                renderItem={(item) => <span className="font-mono text-sm">{item.name}</span>}
                value={existing}
                onValueChange={setExisting}
                listLabel="Branches"
                searchPlaceholder="Search branches"
                loading={branches.isPending}
                className="max-h-64"
              />
            )}
          </div>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-xs text-muted-foreground">Worktree name</span>
            <Input aria-label="Worktree name" className="font-mono" value={effectiveName} onChange={(event) => setName(event.target.value)} />
            {effectiveName && !WORKTREE_NAME_PATTERN.test(effectiveName) ? <span className="text-xs text-destructive">Lowercase letters, digits, dots, dashes and underscores only.</span> : null}
          </label>
          <ErrorNote error={create.error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => navigate('/')}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || create.isPending}>
              {create.isPending ? 'Creating…' : 'Create worktree'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </form>
  )
}
