import type { TurnImage } from '@canopy/shared'

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { MessageAttachment, MessageAttachments } from '@/components/ui/message'
import { plural } from '@/lib/format'

const VISIBLE = 3
const src = (image: TurnImage): string => `data:${image.mediaType};base64,${image.data}`

/** Image previews above a turn, iMessage style: up to three tiles, "+N" on the last when there are more. */
export function ImageTiles({ images, onOpen }: { images: TurnImage[]; onOpen: (index: number) => void }): React.JSX.Element {
  const shown = images.slice(0, VISIBLE)
  const hidden = images.length - shown.length
  return (
    <div className="flex flex-wrap gap-2">
      {shown.map((image, index) => (
        <MessageAttachment key={index} src={src(image)} name={image.label} onClick={() => onOpen(index)} className="size-28">
          {hidden > 0 && index === shown.length - 1 ? (
            <span className="absolute inset-0 flex items-center justify-center bg-background/70 text-lg font-semibold">+{hidden}</span>
          ) : null}
        </MessageAttachment>
      ))}
    </div>
  )
}

/** Full-size viewer, opened on the clicked image and paging through the rest in order. */
export function ImageViewer({ images, index, onClose }: { images: TurnImage[]; index: number | null; onClose: () => void }): React.JSX.Element {
  const start = index ?? 0
  const ordered = [...images.slice(start), ...images.slice(0, start)]
  return (
    <Dialog open={index !== null} onOpenChange={(next) => !next && onClose()}>
      {/* Bare: just the picture (and a pager when there are several); the title is for screen readers. */}
      <DialogContent className="w-auto max-w-[min(96vw,80rem)] gap-0 border-0 bg-transparent p-0 shadow-none sm:max-w-[min(96vw,80rem)]" showCloseButton={false}>
        <DialogTitle className="sr-only">{plural(images.length, 'image')}</DialogTitle>
        <MessageAttachments key={start} className="items-center">
          {ordered.map((image, i) => (
            <img key={i} src={src(image)} alt={image.label} className="max-h-[90vh] max-w-full rounded-xl object-contain" />
          ))}
        </MessageAttachments>
      </DialogContent>
    </Dialog>
  )
}

const REF = /(\[Image #\d+\])/g

/** Message text where each `[Image #N]` is a button that opens that image. */
export function TextWithImageRefs({ text, images, onOpen }: { text: string; images: TurnImage[]; onOpen: (index: number) => void }): React.JSX.Element {
  return (
    <p className="whitespace-pre-wrap text-sm">
      {text.split(REF).map((part, i) => {
        const index = images.findIndex((image) => `[${image.label}]` === part)
        return index >= 0 ? (
          <button key={i} type="button" className="rounded bg-primary-foreground/15 px-1 font-mono text-xs underline-offset-2 hover:underline" onClick={() => onOpen(index)}>
            {part.slice(1, -1)}
          </button>
        ) : (
          <span key={i}>{part}</span>
        )
      })}
    </p>
  )
}
