import { useEffect, useState } from 'react'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FileIcon } from '@/components/ui/file-icon'
import { SearchableListbox } from '@/components/ui/searchable-listbox'
import { useWorktreeFiles } from '@/lib/api-hooks'

/** The name and the folders above it, drawn the way editors draw a quick-open row. */
function split(path: string): { name: string; dir: string } {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? { name: path, dir: '' } : { name: path.slice(cut + 1), dir: path.slice(0, cut) }
}

/** Whether a keystroke is the open-anything shortcut: ⌘O on a Mac, Ctrl+O elsewhere. */
export function isOpenFileShortcut(event: KeyboardEvent): boolean {
  return event.key.toLowerCase() === 'o' && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey
}

/**
 * Open anything in the worktree by name — ⌘O, type, Enter — without walking the tree to it.
 * The path list is one `ls-files` the daemon caps, fetched the first time the dialog opens.
 */
export function FileOpenDialog({ worktreeId, open, onOpenChange, onOpen }: {
  worktreeId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpen: (path: string) => void
}): React.JSX.Element {
  const files = useWorktreeFiles(worktreeId, open)
  const [query, setQuery] = useState('')
  // Every visit starts from an empty box; the last search is never what you want next time.
  useEffect(() => {
    if (open) setQuery('')
  }, [open])

  const paths = files.data?.paths ?? []
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Open file</DialogTitle>
          <DialogDescription>
            {files.error ? files.error.message : files.data?.truncated ? `Searching the first ${paths.length.toLocaleString()} files in the worktree.` : 'Search every file in the worktree by name or path.'}
          </DialogDescription>
        </DialogHeader>
        <div className="overflow-hidden rounded-xl border border-border">
          <SearchableListbox
            items={paths}
            getItemId={(path) => path}
            getItemKeywords={(path) => [path]}
            query={query}
            onQueryChange={setQuery}
            onValueChange={(path) => {
              onOpen(path)
              onOpenChange(false)
            }}
            searchPlaceholder="Search files"
            listLabel="Worktree files"
            loading={files.isPending}
            loadingMessage="Listing files…"
            emptyMessage="No file matches that."
            listClassName="max-h-[50vh]"
            renderItem={(path) => {
              const { name, dir } = split(path)
              return (
                <span className="flex w-full min-w-0 items-center gap-2 px-2 py-1.5">
                  <FileIcon name={name} kind="file" className="size-4 shrink-0" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm">{name}</span>
                    {dir ? <span className="block truncate font-mono text-[10px] text-muted-foreground">{dir}</span> : null}
                  </span>
                </span>
              )
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
