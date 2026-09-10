import { lazy, Suspense, useEffect, useMemo, useRef } from 'react'

import { CodeBlockProvider } from '@/components/ui/code-block'
import { MessageMarkdown } from '@/components/ui/message-markdown'
import { useFileContents } from '@/lib/api-hooks'
import { resolveDocLink, slugify } from '@/lib/doc-links'
import { diffSegments, type SegmentKind } from '@/lib/markdown-diff'
import { whenIdle } from '@/lib/use-idle-preload'
import { useTheme } from '@/lib/use-theme'
import { cn } from '@/lib/utils'

// The editor is a large chunk of its own. It is fetched ahead of the first source file by the
// surfaces that can show one — see `preloadCodeEditor` — and the lazy boundary is what waits
// for it if a file is opened before that fetch is through.
const loadCodeEditor = () => import('./code-editor')
const CodeEditor = lazy(loadCodeEditor)

let warmed = false

/**
 * Starts fetching the editor now, so that the first click on a source file finds it cached —
 * and once it is here, stands one up and tears it down at an idle moment, so the first real
 * instance is not also the one that pays for the editor's setup and its language worker.
 * Idempotent: the browser holds one copy of the chunk however many times this is called.
 */
export function preloadCodeEditor(): void {
  void loadCodeEditor()
    .then((module) => {
      if (warmed) return
      warmed = true
      whenIdle(module.warmCodeEditor)
    })
    .catch(() => {
      // Offline or a stale deploy: the lazy boundary reports it when a file is actually opened.
    })
}

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

/**
 * One file's source in VS Code's editor, read-only: find, folding, go to definition and the
 * rest come with it. `anchor` is a line (`L42`) to land on; a definition in another file opens
 * it through `onOpenPath`, the same way a link out of a rendered doc does.
 */
export function FileViewer({ worktreeId, path, rev, anchor, onOpenPath }: FileProps & { anchor?: string; onOpenPath?: OpenPath }): React.JSX.Element {
  const { theme } = useTheme()
  return (
    <FileText worktreeId={worktreeId} path={path} rev={rev}>
      {(text) => (
        <Suspense fallback={<Note>Loading editor…</Note>}>
          <CodeEditor worktreeId={worktreeId} path={path} text={text} mode={theme} anchor={anchor} onOpenPath={onOpenPath} />
        </Suspense>
      )}
    </FileText>
  )
}

/** Scrolls to the heading a fragment names: an explicit id if the doc has one, else by slugged text. */
function scrollToAnchor(root: HTMLElement, id: string): void {
  const byId = root.querySelector(`[id="${CSS.escape(id)}"], [name="${CSS.escape(id)}"]`)
  const target = byId ?? [...root.querySelectorAll('h1, h2, h3, h4, h5, h6')].find((heading) => slugify(heading.textContent ?? '') === slugify(id))
  target?.scrollIntoView({ block: 'start' })
}

/**
 * Links inside a rendered doc, wired to the viewer instead of the address bar: a relative link
 * opens that file in the pane, a `#fragment` scrolls to its heading, and a link with a scheme
 * falls through to the app's external-link handler. One delegated listener covers every anchor,
 * including those inside html embedded in the markdown.
 */
function useDocLinks(path: string, root: React.RefObject<HTMLDivElement | null>, onOpenPath?: OpenPath): (event: React.MouseEvent<HTMLDivElement>) => void {
  return (event) => {
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
}

/** The whole doc, rendered, with the fragment a link carried in applied once it is on screen. */
function MarkdownDoc({ text, path, anchor, onOpenPath }: { text: string; path: string; anchor?: string; onOpenPath?: OpenPath }): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const onClick = useDocLinks(path, root, onOpenPath)

  useEffect(() => {
    if (root.current && anchor !== undefined) scrollToAnchor(root.current, anchor)
  }, [anchor, text])

  // Parsing is the expensive part, and it only depends on the text: the same element is handed
  // back until the text changes, so a re-render here — a pane resized, an anchor followed — does
  // not run remark over the whole doc again.
  const doc = useMemo(() => <MessageMarkdown className="mx-auto max-w-3xl px-4 py-3 text-sm">{text}</MessageMarkdown>, [text])

  return (
    <div ref={root} onClick={onClick}>
      {doc}
    </div>
  )
}

/** How each run of the document is painted: untouched prose, prose the change added, prose it cut. */
const SEGMENT: Record<SegmentKind, string> = {
  context: 'px-3',
  added: 'rounded-sm border-l-2 border-nessa-diff-addition bg-nessa-diff-addition/10 px-3 py-1',
  removed: 'rounded-sm border-l-2 border-nessa-diff-deletion bg-nessa-diff-deletion/10 px-3 py-1'
}

/** The tint carries the change to the eye; this carries it to a screen reader. */
const SEGMENT_LABEL: Record<SegmentKind, string | undefined> = { context: undefined, added: 'Added:', removed: 'Removed:' }

/**
 * The change to a doc as the doc: the new version rendered as prose, with the blocks the change
 * touched tinted green and the blocks it deleted rendered in red where they stood. A block is
 * the smallest thing that can be rendered on its own, so a paragraph one word changed in is
 * marked whole — the raw diff, one click away, is what line-level reading is for.
 */
function MarkdownDiffDoc({ text, patch, path, onOpenPath }: { text: string; patch: string; path: string; onOpenPath?: OpenPath }): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const onClick = useDocLinks(path, root, onOpenPath)
  const segments = useMemo(() => diffSegments(text, patch), [text, patch])

  return (
    <div ref={root} onClick={onClick} className="mx-auto flex max-w-3xl flex-col gap-1 px-4 py-3">
      {segments.map((segment, index) => (
        <div key={`${segment.kind}:${segment.line}:${index}`} className={cn('min-w-0', SEGMENT[segment.kind])}>
          {SEGMENT_LABEL[segment.kind] ? <span className="sr-only">{SEGMENT_LABEL[segment.kind]}</span> : null}
          <MessageMarkdown className="text-sm">{segment.text}</MessageMarkdown>
        </div>
      ))}
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

/** The same rendering, over the file's patch: prose with the change marked on it. */
export function MarkdownDiff({ worktreeId, path, rev, patch, onOpenPath }: FileProps & { patch: string; onOpenPath?: OpenPath }): React.JSX.Element {
  const { theme } = useTheme()
  return (
    <FileText worktreeId={worktreeId} path={path} rev={rev}>
      {(text) => (
        <CodeBlockProvider mode={theme}>
          <MarkdownDiffDoc text={text} patch={patch} path={path} onOpenPath={onOpenPath} />
        </CodeBlockProvider>
      )}
    </FileText>
  )
}

const Note = ({ children }: { children: React.ReactNode }): React.JSX.Element => <p className="p-3 font-mono text-[11px] text-muted-foreground">{children}</p>
