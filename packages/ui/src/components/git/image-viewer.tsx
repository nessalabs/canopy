import { useEffect, useState } from 'react'

import { ApiError, type ChangedFile, type ChangesResponse, type DiffSpec } from '@canopy/shared'

import { useDiffFiles, useFileBlob } from '@/lib/api-hooks'
import { cn } from '@/lib/utils'

interface FileProps {
  worktreeId: string
  path: string
  /** The blob to show; absent, the working-tree copy. */
  rev?: string
}

/**
 * An object URL for the bytes, revoked when they change or the viewer goes. Held in state
 * rather than a memo so that StrictMode's rehearsal unmount cannot revoke a URL still in use.
 */
function useObjectUrl(blob: Blob | undefined): string | undefined {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    if (!blob) {
      setUrl(undefined)
      return
    }
    const next = URL.createObjectURL(blob)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [blob])
  return url
}

const formatBytes = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`)

const Note = ({ children }: { children: React.ReactNode }): React.JSX.Element => <p className="p-3 font-mono text-[11px] text-muted-foreground">{children}</p>

/**
 * One image on a checkerboard, so a transparent one has an edge to read against, with its
 * pixel size and byte size under it. `missing` is what the side says when there is nothing
 * there to show — a file's first version has no before.
 */
function ImageFigure({ worktreeId, path, rev, missing }: FileProps & { missing: string }): React.JSX.Element {
  const file = useFileBlob(worktreeId, path, rev, true)
  const url = useObjectUrl(file.data)
  const [size, setSize] = useState<{ width: number; height: number }>()
  if (file.isPending) return <Note>Loading image…</Note>
  if (file.error) {
    return file.error instanceof ApiError && file.error.status === 404 ? <Note>{missing}</Note> : <p className="p-3 text-xs text-destructive">{file.error.message}</p>
  }
  if (!url) return <Note>Loading image…</Note>
  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <div
        className="flex min-h-24 items-center justify-center overflow-hidden rounded-md border border-border p-3 text-foreground/10 [background-image:conic-gradient(currentColor_25%,transparent_0_50%,currentColor_0_75%,transparent_0)] [background-size:16px_16px]"
      >
        <img src={url} alt={path} className="max-h-[70vh] max-w-full object-contain" onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
      </div>
      <figcaption className="font-mono text-[11px] text-muted-foreground">
        {size ? `${size.width} × ${size.height} px · ` : ''}
        {formatBytes(file.data.size)}
      </figcaption>
    </figure>
  )
}

/** The current image: the working-tree file, or the blob at `rev`. */
export function ImagePreview({ worktreeId, path, rev }: FileProps): React.JSX.Element {
  return (
    <div className="p-3">
      <ImageFigure worktreeId={worktreeId} path={path} rev={rev} missing="This file is not here." />
    </div>
  )
}

/**
 * Which blob each side of a diff reads. The after side is the one the non-diff views read
 * (see `revOf` in the content pane); the before side is its parent: the commit's first parent,
 * the earlier snapshot tree, or the revision the working tree is compared against. That last
 * one is taken from the changes listing as the commit it resolved to, never as `HEAD`: a blob
 * read is cached by its revision for good, so the name would keep showing the old parent
 * after a commit moved it. The listing is already in the cache whenever the pane is open.
 */
function useSides(worktreeId: string, spec: DiffSpec): { before: string | undefined; after: string | undefined } {
  const changes = useDiffFiles(worktreeId, spec, spec.kind === 'worktree')
  if (spec.kind === 'commit') return { before: `${spec.sha}^`, after: spec.sha }
  if (spec.kind === 'trees') return { before: spec.before, after: spec.after }
  return { before: (changes.data as ChangesResponse | undefined)?.rev, after: undefined }
}

/**
 * The before and after of an image, side by side where the pane is wide enough and stacked
 * where it is not. An added file has only an after and a deleted one only a before; those
 * show alone rather than beside an empty frame.
 */
export function ImageDiff({ worktreeId, spec, file }: { worktreeId: string; spec: DiffSpec; file: ChangedFile }): React.JSX.Element {
  const sides = useSides(worktreeId, spec)
  const showBefore = file.status !== 'A' && file.status !== 'U'
  const showAfter = file.status !== 'D'
  if (showBefore && sides.before === undefined) return <Note>Loading diff…</Note>
  return (
    <div className="@container p-3">
      <div className={cn('grid gap-4', showBefore && showAfter && '@2xl:grid-cols-2')}>
        {showBefore ? (
          <section className="flex min-w-0 flex-col gap-2">
            <h3 className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">Before</h3>
            <ImageFigure worktreeId={worktreeId} path={file.path} rev={sides.before} missing="No earlier version of this file." />
          </section>
        ) : null}
        {showAfter ? (
          <section className="flex min-w-0 flex-col gap-2">
            <h3 className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">After</h3>
            <ImageFigure worktreeId={worktreeId} path={file.path} rev={sides.after} missing="This file is not here." />
          </section>
        ) : null}
      </div>
    </div>
  )
}
