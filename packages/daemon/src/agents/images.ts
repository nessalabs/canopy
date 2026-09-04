import { ImageMediaType, type TurnImage } from '@canopy/shared'

export interface ImageBlock {
  type: 'image'
  source?: { type?: string; media_type?: string; data?: string }
}

const PLACEHOLDER = /\[Image #(\d+)\]/g

/**
 * Pairs a message's base64 image blocks with the `[Image #N]` placeholders Claude Code
 * writes into the prose, in order; images beyond the placeholders are numbered by position.
 */
export function imagesFromBlocks(blocks: Array<{ type: string }>, prose: string): TurnImage[] {
  const labels = [...prose.matchAll(PLACEHOLDER)].map((m) => `Image #${m[1]}`)
  return blocks
    .filter((block): block is ImageBlock => block.type === 'image')
    .flatMap((block, index) => {
      const media = ImageMediaType.safeParse(block.source?.media_type)
      if (block.source?.type !== 'base64' || !media.success || !block.source.data) return []
      return [{ label: labels[index] ?? `Image ${index + 1}`, mediaType: media.data, data: block.source.data }]
    })
}

/** The Anthropic content blocks for images attached to an outgoing turn. */
export const toImageBlocks = (images: Array<Omit<TurnImage, 'label'>>) =>
  images.map((image) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: image.mediaType, data: image.data } }))
