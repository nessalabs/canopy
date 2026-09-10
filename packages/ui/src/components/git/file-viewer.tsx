import { CodeBlock, CodeBlockProvider } from '@/components/ui/code-block'
import { MessageMarkdown } from '@/components/ui/message-markdown'
import { useFileContents } from '@/lib/api-hooks'
import { useTheme } from '@/lib/use-theme'

interface FileProps {
  worktreeId: string
  path: string
  rev?: string
}

/** Fetches one file — the working-tree copy, or the blob at `rev` — and hands its text to `children`. */
function FileText({ worktreeId, path, rev, children }: FileProps & { children: (text: string) => React.JSX.Element }): React.JSX.Element {
  const file = useFileContents(worktreeId, path, rev, true)
  if (file.isPending) return <Note>Reading file…</Note>
  if (file.error) return <p className="p-3 text-xs text-destructive">{file.error.message}</p>
  if (file.data.content === null) return <Note>{file.data.binary ? 'Binary file.' : 'File too large to display (over 2 MiB).'}</Note>
  return children(file.data.content)
}

/** One file's full text with line numbers. */
export function FileViewer({ worktreeId, path, rev }: FileProps): React.JSX.Element {
  const { theme } = useTheme()
  return <FileText worktreeId={worktreeId} path={path} rev={rev}>{(text) => <CodeBlock code={text} filename={path} lineNumbers mode={theme} className="rounded-none" />}</FileText>
}

/**
 * One markdown file as it reads: GFM prose and tables, highlighted fences, TeX math, and
 * ```mermaid fences drawn as diagrams — all through Nessa's own renderers, so the code theme
 * and the diagrams follow the app's light/dark choice.
 */
export function MarkdownPreview({ worktreeId, path, rev }: FileProps): React.JSX.Element {
  const { theme } = useTheme()
  return (
    <FileText worktreeId={worktreeId} path={path} rev={rev}>
      {(text) => (
        <CodeBlockProvider mode={theme}>
          <MessageMarkdown className="mx-auto max-w-3xl px-4 py-3 text-sm">{text}</MessageMarkdown>
        </CodeBlockProvider>
      )}
    </FileText>
  )
}

const Note = ({ children }: { children: React.ReactNode }): React.JSX.Element => <p className="p-3 font-mono text-[11px] text-muted-foreground">{children}</p>
