import { useState } from 'react'
import { AlertTriangle, Check, ScanSearch } from 'lucide-react'
import { useLocation } from 'wouter'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useAddProject, useScanProject } from '@/lib/api-hooks'
import { plural } from '@/lib/format'

import { ErrorNote } from './error-note'

export function AddProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }): React.JSX.Element {
  const [, navigate] = useLocation()
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const scan = useScanProject()
  const add = useAddProject()
  const result = scan.data

  const close = (next: boolean): void => {
    onOpenChange(next)
    if (!next) {
      setPath('')
      setName('')
      scan.reset()
      add.reset()
    }
  }

  const runScan = (): void => {
    scan.mutate(path.trim(), { onSuccess: (data) => setName(data.name) })
  }

  const submit = (): void => {
    if (!result) return
    add.mutate({ path: result.path, name: name.trim() }, {
      onSuccess: (project) => {
        close(false)
        navigate(`/projects/${project.id}/settings`)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a project</DialogTitle>
          <DialogDescription>
            Point Canopy at a git repository on the daemon's machine. Every worktree of that repo shows up in the sidebar.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              runScan()
            }}
          >
            <Input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="/home/you/dev/my-app"
              className="font-mono"
              aria-label="Repository path"
              autoFocus
            />
            <Button type="submit" variant="outline" disabled={path.trim().length < 2 || scan.isPending}>
              <ScanSearch />
              Scan
            </Button>
          </form>
          <ErrorNote error={scan.error} />
          {result ? (
            <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-muted/40 p-3">
              <p className="flex items-center gap-1.5 text-sm">
                {result.canopyYaml.present ? (
                  <>
                    {result.canopyYaml.valid ? <Check className="size-4 text-nessa-diff-addition" /> : <AlertTriangle className="size-4 text-destructive" />}
                    <span className="font-mono">canopy.yaml</span>
                    <span className="text-muted-foreground">{result.canopyYaml.valid ? 'found' : 'has errors'}</span>
                  </>
                ) : (
                  <span className="text-muted-foreground">No canopy.yaml yet — you can add one later.</span>
                )}
              </p>
              {result.canopyYaml.errors.map((error) => (
                <p key={error} className="font-mono text-[11px] text-destructive">
                  {error}
                </p>
              ))}
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="outline" className="font-mono text-[10px]">
                  {result.defaultBranch}
                </Badge>
                <Badge variant="outline" className="text-[10px]">
                  {plural(result.branches.length, 'branch').replace('branchs', 'branches')}
                </Badge>
                {result.compose ? (
                  <Badge variant="outline" className="text-[10px]">
                    compose: {result.compose.services.join(', ') || result.compose.file}
                  </Badge>
                ) : null}
                {result.ecosystems.map((ecosystem) => (
                  <Badge key={ecosystem} variant="secondary" className="text-[10px]">
                    {ecosystem}
                  </Badge>
                ))}
              </div>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="text-xs text-muted-foreground">Project name</span>
                <Input value={name} onChange={(event) => setName(event.target.value)} className="font-mono" />
              </label>
              <ErrorNote error={add.error} />
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={!result || name.trim() === '' || add.isPending} onClick={submit}>
            Add project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
