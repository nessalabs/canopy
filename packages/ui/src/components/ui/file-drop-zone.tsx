"use client"

import * as React from "react"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * Why a dropped file was not handed to the host.
 *
 * - `type` — the file did not match the `accept` list.
 * - `size` — the file was larger than `maxSize`.
 * - `count` — the drop exceeded `maxFiles`, or carried more than one file
 *   into a zone that is not `multiple`.
 * - `folder` — a directory that produced no files: one a zone with
 *   `directories` off declined to expand, or an empty one. The `file` is
 *   the browser's directory placeholder, not a real file.
 */
export type FileDropRejectionReason = "type" | "size" | "count" | "folder"

/** One file the zone refused, paired with the rule that refused it. */
export interface FileDropRejection {
  /** The file as the browser handed it over. */
  file: File
  /** The rule that refused the file. */
  reason: FileDropRejectionReason
}

/**
 * The zone's live drag state, handed to a function child and mirrored onto
 * the root as `data-dragging` / `data-disabled` so purely visual hosts can
 * style from CSS without reading it in JavaScript.
 */
export interface FileDropZoneState {
  /** A file drag is currently over the zone. */
  isDragging: boolean
  /** The zone is refusing drops. */
  disabled: boolean
}

/**
 * Reports whether a file satisfies an `accept` list written in the same
 * syntax as the native input attribute: a comma-separated list of
 * extensions (`.pdf`), wildcard types (`image/*`), and exact MIME types
 * (`application/json`). An empty or absent list accepts everything.
 */
function matchesAccept(file: File, accept: string | undefined): boolean {
  if (!accept) return true
  const patterns = accept
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
  if (patterns.length === 0) return true
  const type = file.type.toLowerCase()
  const name = file.name.toLowerCase()
  return patterns.some((pattern) => {
    if (pattern.startsWith(".")) return name.endsWith(pattern)
    if (pattern.endsWith("/*")) return type.startsWith(pattern.slice(0, -1))
    return type === pattern
  })
}

/** Resolves one directory entry's immediate children, batch by batch. */
function readDirectory(
  entry: FileSystemDirectoryEntry,
): Promise<FileSystemEntry[]> {
  const reader = entry.createReader()
  return new Promise((resolve) => {
    const entries: FileSystemEntry[] = []
    const readBatch = () => {
      reader.readEntries(
        (batch) => {
          // readEntries yields at most 100 entries per call and signals the
          // end of the directory with an empty batch.
          if (batch.length === 0) {
            resolve(entries)
            return
          }
          entries.push(...batch)
          readBatch()
        },
        () => resolve(entries),
      )
    }
    readBatch()
  })
}

/** Resolves one entry subtree into files, depth-first. */
async function filesFromEntry(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) => {
      ;(entry as FileSystemFileEntry).file(resolve, () => resolve(null))
    })
    return file ? [file] : []
  }
  if (!entry.isDirectory) return []
  const children = await readDirectory(entry as FileSystemDirectoryEntry)
  const nested = await Promise.all(children.map(filesFromEntry))
  return nested.flat()
}

/** What one drop carried, once folders are resolved or set aside. */
interface DroppedFiles {
  /** Real files, in drop order. */
  files: File[]
  /**
   * Directory placeholders a zone with `directories` off declined to
   * expand. Browsers hand these over as zero-byte, type-less `File`s that
   * a host would otherwise attach as empty attachments.
   */
  folders: File[]
}

/**
 * Collects the files a drop carried. Entries must be read out of
 * `DataTransfer` synchronously — the browser neuters the item list as soon
 * as the drop handler yields — so this takes the entries first and only
 * then awaits their expansion. The entry API is also what tells a folder
 * apart from an empty file; without it (no entries at all) every payload
 * is taken at face value, since guessing from `size === 0` would reject
 * real empty files like an untouched LICENSE.
 */
async function filesFromDataTransfer(
  dataTransfer: DataTransfer,
  directories: boolean,
): Promise<DroppedFiles> {
  const files = Array.from(dataTransfer.files)
  const entries = Array.from(dataTransfer.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.webkitGetAsEntry())
  if (entries.every((entry) => entry === null)) return { files, folders: [] }

  // Both results are filled by item position, not by arrival: `maxFiles`
  // cuts along this sequence, so a folder's contents must hold the place
  // the folder was dropped in rather than trailing every loose file.
  const filesByItem: File[][] = entries.map(() => [])
  const foldersByItem: File[][] = entries.map(() => [])
  const expanding: Promise<unknown>[] = []
  entries.forEach((entry, index) => {
    const file = files[index]
    if (entry === null || !entry.isDirectory) {
      if (file) filesByItem[index] = [file]
      return
    }
    if (!directories) {
      if (file) foldersByItem[index] = [file]
      return
    }
    expanding.push(
      filesFromEntry(entry).then((expandedFiles) => {
        filesByItem[index] = expandedFiles
        // An expansion that found nothing is an empty folder. Reporting it
        // keeps the drop from looking like it never happened.
        if (expandedFiles.length === 0 && file) foldersByItem[index] = [file]
      }),
    )
  })
  await Promise.all(expanding)
  return { files: filesByItem.flat(), folders: foldersByItem.flat() }
}

/**
 * The drops one zone has already taken. A drop bubbles through every
 * ancestor zone, so the innermost one claims the event and the rest let it
 * pass: nesting a zone inside a zone must attach the file once, not once
 * per level. `preventDefault` cannot carry this signal — descendants that
 * are not zones (the composer's editor, say) prevent drops of their own.
 * Nesting therefore holds within one copy of this module: zones from a
 * registry-installed copy and from the package do not see each other's
 * claims, so nest zones that come from the same place.
 *
 * A nested drop target that is NOT a zone — a host's own dragover/drop
 * handlers — is invisible to this bookkeeping, since `preventDefault` is
 * how every drop target marks itself and cannot also mean "mine alone".
 * Such a target owns its region by calling `stopPropagation()` on its
 * `dragenter`, `dragover`, `dragleave`, and `drop` handlers alike, which
 * keeps them from reaching the zone at all. Stopping only some of them
 * would leave the zone counting enters it never sees the leave for, so
 * the zone also resets itself from the capture phase of a drop, which no
 * descendant can stop.
 */
const claimedDrags = new WeakSet<Event>()

/** Claims one drag event for the innermost zone; false once already claimed. */
function claimDrag(event: Event): boolean {
  if (claimedDrags.has(event)) return false
  claimedDrags.add(event)
  return true
}

/** The zone's out-of-the-box English drag announcement. */
export const fileDropZoneDefaultLabel = "Drop files to attach"

/**
 * Every div prop except `children`, which the zone re-types, and `onDrop`,
 * which it owns outright: a host handler there would run against the same
 * event the zone filters, so files reach hosts through `onFiles` only.
 */
export interface FileDropZoneProps
  extends Omit<React.ComponentProps<"div">, "children" | "onDrop"> {
  /**
   * Receives the files that passed every rule, in drop order. This is the
   * whole point of the zone: the host turns them into attachments and owns
   * every subsequent decision about them.
   */
  onFiles: (files: File[]) => void
  /**
   * Receives the files the zone refused, with the rule that refused each,
   * so hosts can explain the refusal instead of dropping it silently.
   * Refused files come first in drop order, then any folders; one drop can
   * call both this and `onFiles`, so a host announcing the outcome should
   * report both halves rather than the last one to arrive.
   */
  onRejectedFiles?: (rejections: FileDropRejection[]) => void

  /**
   * Announced to assistive technology while a file drag is over the zone.
   * Under `asChild` the zone owns no DOM to announce through, so the
   * merged host announces the drag itself — see
   * `fileDropZoneDefaultLabel`.
   */
  label?: string
  /**
   * Renders the zone onto its child element instead of a wrapper div, so
   * the zone adds no DOM and cannot disturb the child's layout. The child
   * receives the drag handlers and `data-dragging`, and must be a single
   * element that forwards props and ref — a function child works too, as
   * long as it returns one. `overlay` needs DOM of the zone's own and is
   * inert here: the merged host draws its own drag affordance.
   */
  asChild?: boolean
  /**
   * Absolutely positioned content drawn over the zone while a file drag is
   * in progress — a drop hint, say. The zone draws nothing by default and
   * nothing under `asChild`: the usual way to show a drag is to style the
   * children themselves from `data-dragging`.
   */
  overlay?: React.ReactNode
  /**
   * The accepted files, in native input `accept` syntax
   * (`"image/*,.pdf"`). Files outside it are rejected with reason `type`.
   */
  accept?: string
  /** Accepts more than one file per drop. Defaults to true. */
  multiple?: boolean
  /** The most files one drop may hand over; the rest are rejected as `count`. */
  maxFiles?: number
  /** The largest file the zone accepts, in bytes; larger files reject as `size`. */
  maxSize?: number
  /**
   * Expands dropped folders into their files, recursively. Defaults to
   * true; turn it off when the host wants only what the person picked
   * directly.
   */
  directories?: boolean
  /**
   * Refuses drags and drops. A disabled zone claims nothing, so a drop
   * over it still reaches an enabled zone wrapping it.
   */
  disabled?: boolean
  /**
   * The wrapped content, or a function of the live drag state for hosts
   * that render their own drag affordance.
   */
  children?: React.ReactNode | ((state: FileDropZoneState) => React.ReactNode)
}

/**
 * Wraps any content in a file drop target: drag files or folders anywhere
 * over the wrapped subtree and the zone hands the host a filtered `File[]`
 * through `onFiles`. The zone owns only the drag protocol — enter/leave
 * bookkeeping across nested children, the accept, size, and count rules,
 * folder expansion, and the drag affordance. It stores nothing: hosts turn
 * the files into attachments and render them however they like, either as
 * ordinary children or from the drag state a function child receives.
 *
 * Zones nest, and the innermost one takes the drop. A nested drop target
 * of the host's own instead calls `stopPropagation()` on its drag events
 * to keep them from the zone; without that the zone treats the region as
 * its own and delivers the same files a second time.
 */
function FileDropZone({
  onFiles,
  onRejectedFiles,
  label = fileDropZoneDefaultLabel,
  asChild = false,
  overlay,
  accept,
  multiple = true,
  maxFiles,
  maxSize,
  directories = true,
  disabled = false,
  className,
  children,
  onDragEnter,
  onDragOver,
  onDragLeave,
  ...props
}: FileDropZoneProps) {
  const [isDragging, setIsDragging] = React.useState(false)
  // Every child element fires its own dragenter/dragleave as the pointer
  // crosses it, so the zone counts depth instead of trusting a single leave.
  const depth = React.useRef(0)

  /** Splits files into the accepted list and the rejections, in drop order. */
  const partition = React.useCallback(
    (files: File[]) => {
      const accepted: File[] = []
      const rejected: FileDropRejection[] = []
      const limit = multiple ? maxFiles : 1
      for (const file of files) {
        if (limit !== undefined && accepted.length >= limit) {
          rejected.push({ file, reason: "count" })
        } else if (!matchesAccept(file, accept)) {
          rejected.push({ file, reason: "type" })
        } else if (maxSize !== undefined && file.size > maxSize) {
          rejected.push({ file, reason: "size" })
        } else {
          accepted.push(file)
        }
      }
      return { accepted, rejected }
    },
    [accept, maxFiles, maxSize, multiple],
  )

  const deliver = React.useCallback(
    ({ files, folders }: DroppedFiles) => {
      const { accepted, rejected } = partition(files)
      for (const folder of folders) rejected.push({ file: folder, reason: "folder" })
      if (accepted.length > 0) onFiles(accepted)
      if (rejected.length > 0) onRejectedFiles?.(rejected)
    },
    [onFiles, onRejectedFiles, partition],
  )

  // A zone disabled mid-drag never sees the matching dragleave, so the
  // depth it already counted would strand the drag state on forever.
  React.useEffect(() => {
    if (!disabled) return
    depth.current = 0
    setIsDragging(false)
  }, [disabled])

  const state: FileDropZoneState = { isDragging, disabled }

  // Under asChild the zone is the child element itself: no wrapper, no
  // positioning context of its own, and so no overlay — that needs DOM
  // the merged host owns instead.
  const Root = asChild ? Slot.Root : "div"

  return (
    <Root
      data-slot="file-drop-zone"
      data-dragging={isDragging || undefined}
      data-disabled={disabled || undefined}
      className={cn(
        // A wrapper needs a positioning context for the overlay and must
        // not force its content wider than the host box; the merged form
        // brings its own layout and gets nothing but the caller's classes.
        !asChild && "relative min-w-0",
        className,
      )}
      onDragEnter={(event) => {
        onDragEnter?.(event)
        if (disabled) return
        if (!event.dataTransfer.types.includes("Files")) return
        // Deliberately not gated on defaultPrevented: a nested drop target
        // of the host's own prevents its dragenter as the standard idiom,
        // and enter must stay symmetric with leave or depth never returns
        // to zero. Hosts turn the zone off with `disabled`.
        if (!claimDrag(event.nativeEvent)) return
        event.preventDefault()
        depth.current += 1
        setIsDragging(true)
      }}
      onDragOver={(event) => {
        onDragOver?.(event)
        if (!event.dataTransfer.types.includes("Files")) return
        // Without preventDefault the browser navigates to the dropped file.
        // A disabled zone still prevents it — the drop must not navigate
        // whoever ends up ignoring it — but claims nothing, so the cursor
        // is written by the same zone the drop will reach.
        event.preventDefault()
        if (disabled) return
        if (!claimDrag(event.nativeEvent)) return
        event.dataTransfer.dropEffect = "copy"
      }}
      onDragLeave={(event) => {
        onDragLeave?.(event)
        if (disabled) return
        // Claimed symmetrically with dragenter: an inner zone owning the
        // enter must own the leave too, or this zone's depth never returns
        // to zero and the drag state sticks. The pointer crossing into a
        // nested zone therefore drops this zone's own affordance — the
        // innermost zone owns the drag, and this one lights again when the
        // pointer comes back out.
        if (!claimDrag(event.nativeEvent)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setIsDragging(false)
      }}
      onDropCapture={(event) => {
        // A drop ends the drag, and no dragleave follows it. Reading that
        // in the capture phase means a descendant that stops propagation
        // — the documented way to own a region — cannot strand the drag
        // state on. Delivery stays in the bubble phase, where such a
        // descendant is meant to win.
        if (!event.dataTransfer.types.includes("Files")) return
        depth.current = 0
        setIsDragging(false)
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return
        event.preventDefault()
        depth.current = 0
        setIsDragging(false)
        // A disabled zone claims nothing: the drop belongs to whichever
        // enabled ancestor would otherwise have taken it.
        if (disabled) return
        // The innermost enabled zone attaches the files; ancestors only reset.
        if (!claimDrag(event.nativeEvent)) return
        void filesFromDataTransfer(event.dataTransfer, directories)
          .then(deliver)
          .catch((error: unknown) => {
            // Rethrow out of the promise so a failed read, or a host
            // handler that threw, surfaces as an error the page can report
            // instead of a silent unhandled rejection.
            setTimeout(() => {
              throw error
            })
          })
      }}
      {...props}
    >
      {asChild ? (
        // Slot takes exactly one child, so the merged form stands alone.
        typeof children === "function" ? children(state) : children
      ) : (
        <>
          {typeof children === "function" ? children(state) : children}
          {isDragging && overlay ? (
            <div
              data-slot="file-drop-zone-overlay"
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 z-10 rounded-[inherit]"
            >
              {overlay}
            </div>
          ) : null}
          <span aria-live="polite" className="sr-only">
            {isDragging && !disabled ? label : ""}
          </span>
        </>
      )}
    </Root>
  )
}

export { FileDropZone }
