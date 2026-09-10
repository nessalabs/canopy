import { useEffect, useRef } from 'react'

import { CodeBlock, CodeBlockProvider } from '@/components/ui/code-block'
import { MessageMarkdown } from '@/components/ui/message-markdown'
import { useFileContents } from '@/lib/api-hooks'
import { resolveDocLink, slugify } from '@/lib/doc-links'
import { useTheme } from '@/lib/use-theme'

interface FileProps {
  worktreeId: string
  path: string
  rev?: string
}

/** Opens the file a doc link points at — the resolved worktree path, plus any `#heading` on it. */
export type OpenPath = (path: string, hash?: string) => void

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

/** Scrolls to the heading a fragment names: an explicit id if the doc has one, else by slugged text. */
function scrollToAnchor(root: HTMLElement, id: string): void {
  const byId = root.querySelector(`[id="${CSS.escape(id)}"], [name="${CSS.escape(id)}"]`)
  const target = byId ?? [...root.querySelectorAll('h1, h2, h3, h4, h5, h6')].find((heading) => slugify(heading.textContent ?? '') === slugify(id))
  target?.scrollIntoView({ block: 'start' })
}

/**
 * The rendered doc, with its links wired to the viewer instead of the address bar: a relative
 * link opens that file in the pane, a `#fragment` scrolls to its heading, and a link with a
 * scheme falls through to the app's external-link handler. One delegated listener covers every
 * anchor, including those inside html embedded in the markdown.
 */
function MarkdownDoc({ text, path, anchor, onOpenPath }: { text: string; path: string; anchor?: string; onOpenPath?: OpenPath }): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)

  // The fragment carried in from another doc's link, applied once this doc's prose is on screen.
  useEffect(() => {
    if (root.current && anchor !== undefined) scrollToAnchor(root.current, anchor)
  }, [anchor, text])

  const onClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const anchorEl = (event.target as Element | null)?.closest?.('a[href]')
    if (!(anchorEl instanceof HTMLAnchorElement)) return
    const link = resolveDocLink(path, anchorEl.getAttribute('href') ?? undefined)
    if (link === null) return
    // Either way the browser must not follow it: a relative href would reload the app onto a
    // route that does not exist, which is how these links used to land on the environment screen.
    event.preventDefault()
    if (link.kind === 'anchor') {
      if (root.current) scrollToAnchor(root.current, link.id)
      return
    }
    onOpenPath?.(link.path, link.hash)
  }

  return (
    <div ref={root} onClick={onClick}>
      <MessageMarkdown className="mx-auto max-w-3xl px-4 py-3 text-sm">{text}</MessageMarkdown>
    </div>
  )
}

/**
 * One markdown file as it reads: GFM prose and tables, highlighted fences, TeX math, and
 * ```mermaid fences drawn as diagrams — all through Nessa's own renderers, so the code theme
 * and the diagrams follow the app's light/dark choice. Links between docs stay inside the
 * viewer: `onOpenPath` is called with the file a relative link resolves to.
 */
export function MarkdownPreview({ worktreeId, path, rev, anchor, onOpenPath }: FileProps & { anchor?: string; onOpenPath?: OpenPath }): React.JSX.Element {
  const { theme } = useTheme()
  return (
    <FileText worktreeId={worktreeId} path={path} rev={rev}>
      {(text) => (
        <CodeBlockProvider mode={theme}>
          <MarkdownDoc text={text} path={path} anchor={anchor} onOpenPath={onOpenPath} />
        </CodeBlockProvider>
      )}
    </FileText>
  )
}

const Note = ({ children }: { children: React.ReactNode }): React.JSX.Element => <p className="p-3 font-mono text-[11px] text-muted-foreground">{children}</p>
