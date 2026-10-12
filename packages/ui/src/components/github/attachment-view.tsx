import { AttachmentPreview } from '@/components/agent/attachment-preview'
import { ErrorNote } from '@/components/error-note'
import { useGitHubAttachment } from '@/lib/api-hooks'

/** A file someone attached on GitHub, fetched through the daemon and read like any attachment. */
export function GitHubAttachmentView({ projectId, url }: { projectId: string; url: string }): React.JSX.Element {
  const file = useGitHubAttachment(projectId, url)
  if (file.error) return <ErrorNote error={file.error} />
  if (!file.data) return <p className="p-4 text-xs text-muted-foreground">Downloading the attachment from GitHub…</p>
  return <AttachmentPreview attachment={{ label: file.data.name, text: file.data.text }} />
}

/** The file name a GitHub attachment URL ends in, for a panel title before the file arrives. */
export const attachmentName = (url: string): string => decodeURIComponent(new URL(url).pathname.split('/').pop() ?? 'Attachment')
