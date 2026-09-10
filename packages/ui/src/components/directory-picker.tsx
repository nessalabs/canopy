import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Eye, EyeOff, File, Folder, FolderGit2, Home, Loader2, Search } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useDirs } from '@/lib/api-hooks'
import { breadcrumbs, filterEntries, withTilde } from '@/lib/fs-ui'
import { plural } from '@/lib/format'
import { cn } from '@/lib/utils'

import { ErrorNote } from './error-note'

/**
 * Browses folders on the daemon's machine (not the browser's) so a repository can be picked
 * instead of typed. Folders open on click or Enter; files are shown for orientation and
 * search only. The filter box narrows the current folder by name; Enter in it opens the single
 * matching folder. "Use this folder" returns the folder currently shown.
 */
export function DirectoryPicker({
  open,
  onOpenChange,
  initialPath,
  onPick
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Where to start; the daemon user's home when empty or missing. */
  initialPath?: string
  onPick: (path: string) => void
}): React.JSX.Element {
  const [path, setPath] = useState<string | undefined>(initialPath?.trim() || undefined)
  const [typed, setTyped] = useState('')
  const [query, setQuery] = useState('')
  const [hidden, setHidden] = useState(false)
  const filterRef = useRef<HTMLInputElement>(null)
  const listing = useDirs(path, hidden, open)
  const current = listing.data

  // Reopening starts from the caller's current value again.
  useEffect(() => {
    if (open) {
      setPath(initialPath?.trim() || undefined)
      setQuery('')
    }
  }, [open, initialPath])
  useEffect(() => {
    if (current) setTyped(current.path)
  }, [current?.path])

  const visible = useMemo(() => filterEntries(current?.entries ?? [], query), [current?.entries, query])
  const folders = visible.filter((entry) => entry.kind === 'dir')
  const files = visible.length - folders.length

  const go = (next: string): void => {
    setPath(next)
    setQuery('')
    filterRef.current?.focus()
  }
  const submitTyped = (): void => {
    if (typed.trim()) go(typed.trim())
  }
  /** Enter in the filter opens the one folder that matches — typing a name is the fastest way down a tree. */
  const submitFilter = (): void => {
    const exact = folders.find((entry) => entry.name.toLowerCase() === query.trim().toLowerCase())
    const target = exact ?? (folders.length === 1 ? folders[0] : undefined)
    if (target) go(target.path)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Choose a folder</DialogTitle>
          <DialogDescription>Folders on the machine running canopyd. Repositories are marked; pick the repo root.</DialogDescription>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            submitTyped()
          }}
        >
          <Button type="button" variant="outline" size="icon" aria-label="Home folder" onClick={() => current && go(current.home)}>
            <Home />
          </Button>
          <Button type="button" variant="outline" size="icon" aria-label="Parent folder" disabled={!current?.parent} onClick={() => current?.parent && go(current.parent)}>
            <ArrowUp />
          </Button>
          <Input value={typed} onChange={(event) => setTyped(event.target.value)} className="font-mono text-xs" aria-label="Folder path" spellCheck={false} />
          <Button type="button" variant="ghost" size="icon" aria-label={hidden ? 'Hide dotfiles' : 'Show dotfiles'} aria-pressed={hidden} onClick={() => setHidden((value) => !value)}>
            {hidden ? <EyeOff /> : <Eye />}
          </Button>
        </form>
        {current ? (
          <nav aria-label="Path" className="flex flex-wrap items-center gap-0.5 font-mono text-[11px] text-muted-foreground">
            {breadcrumbs(current.path).map((crumb, index, all) => (
              <span key={crumb.path} className="flex items-center gap-0.5">
                <button type="button" className={cn('rounded px-1 py-0.5 hover:bg-accent hover:text-foreground', index === all.length - 1 && 'text-foreground')} onClick={() => go(crumb.path)}>
                  {crumb.label}
                </button>
                {index < all.length - 1 && crumb.label !== '/' ? <span aria-hidden>/</span> : null}
              </span>
            ))}
          </nav>
        ) : null}
        <form
          className="relative"
          onSubmit={(event) => {
            event.preventDefault()
            submitFilter()
          }}
        >
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={filterRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter files and folders in this directory"
            className="h-8 pl-8 text-sm"
            aria-label="Filter files and folders"
            autoFocus
          />
        </form>
        <ErrorNote error={listing.error} />
        {/* A fixed height is what makes the list scroll instead of growing the dialog past the viewport. */}
        <ScrollArea className="h-[min(45vh,26rem)] rounded-lg border border-border">
          <ul className="flex flex-col p-1" aria-label="Entries">
            {listing.isPending ? (
              <li className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Reading folder…
              </li>
            ) : null}
            {current && current.entries.length === 0 ? <li className="p-3 text-xs text-muted-foreground">This folder is empty.</li> : null}
            {current && current.entries.length > 0 && visible.length === 0 ? <li className="p-3 text-xs text-muted-foreground">Nothing here matches “{query}”.</li> : null}
            {visible.map((entry) =>
              entry.kind === 'dir' ? (
                <li key={entry.path}>
                  <button
                    type="button"
                    className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none', entry.hidden && 'text-muted-foreground')}
                    onClick={() => go(entry.path)}
                  >
                    {entry.isGitRepo ? <FolderGit2 className="size-4 shrink-0 text-primary" /> : <Folder className="size-4 shrink-0 text-muted-foreground" />}
                    <span className="truncate font-mono">{entry.name}</span>
                    {entry.isGitRepo ? (
                      <Badge variant="secondary" className="ml-auto text-[10px]">
                        git repo
                      </Badge>
                    ) : null}
                  </button>
                </li>
              ) : (
                <li key={entry.path} className="flex items-center gap-2 px-2 py-1 text-sm text-muted-foreground/70" aria-label={`${entry.name} (file)`}>
                  <File className="size-4 shrink-0" />
                  <span className="truncate font-mono">{entry.name}</span>
                </li>
              )
            )}
          </ul>
        </ScrollArea>
        <div className="flex items-center justify-between gap-2 font-mono text-[11px] text-muted-foreground">
          <span className="truncate" title={current?.path}>
            {current ? withTilde(current.path, current.home) : ''}
            {current?.isGitRepo ? ' · git repository' : ''}
          </span>
          {current ? (
            <span className="shrink-0">
              {plural(folders.length, 'folder')} · {plural(files, 'file')}
              {query ? ' matching' : ''}
              {current.truncated ? ' · list capped' : ''}
            </span>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!current}
            onClick={() => {
              if (!current) return
              onPick(current.path)
              onOpenChange(false)
            }}
          >
            Use this folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
