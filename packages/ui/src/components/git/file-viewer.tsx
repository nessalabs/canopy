import { CodeBlock } from '@/components/ui/code-block'
import { useFileContents } from '@/lib/api-hooks'
import { useTheme } from '@/lib/use-theme'

/** One file's full text with line numbers; the working-tree copy, or the blob at `rev`. */
export function FileViewer({ worktreeId, path, rev }: { worktreeId: string; path: string; rev?: string }): React.JSX.Element {
  const { theme } = useTheme()
  const file = useFileContents(worktreeId, path, rev, true)
  if (file.isPending) return <Note>Reading file…</Note>
  if (file.error) return <p className="p-3 text-xs text-destructive">{file.error.message}</p>
  if (file.data.content === null) return <Note>{file.data.binary ? 'Binary file.' : 'File too large to display (over 2 MiB).'}</Note>
  return <CodeBlock code={file.data.content} filename={path} lineNumbers mode={theme} className="rounded-none" />
}

const Note = ({ children }: { children: React.ReactNode }): React.JSX.Element => <p className="p-3 font-mono text-[11px] text-muted-foreground">{children}</p>
