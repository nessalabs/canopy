import { MarkdownDoc } from '@/components/git/file-viewer'

/** Text staged in the composer, opened to be read before it is sent. */
export interface PreviewedAttachment {
  label: string
  text: string
  /** An issue or PR mentioned with `#`, opened as itself rather than as text. */
  issue?: number
}

const MARKDOWN = /\.(md|markdown|mdx)$/i

/**
 * What the preview renders: a markdown file as itself, anything else as one fenced block in its
 * extension's language — fenced longer than any backtick run inside, so the text cannot close it.
 */
export function previewMarkdown({ label, text }: PreviewedAttachment): string {
  if (MARKDOWN.test(label)) return text
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(([run]) => run.length + 1)))
  const language = /\.([a-z0-9]+)$/i.exec(label)?.[1]?.toLowerCase() ?? ''
  return `${fence}${language}\n${text}\n${fence}`
}

/** An attachment read in a pane of its own, through the same renderer the file viewer uses. */
export function AttachmentPreview({ attachment }: { attachment: PreviewedAttachment }): React.JSX.Element {
  return <MarkdownDoc text={previewMarkdown(attachment)} path={attachment.label} />
}
