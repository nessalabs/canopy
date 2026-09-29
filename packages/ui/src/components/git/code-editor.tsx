import { useEffect, useRef } from 'react'

import { fileUri, monaco, onOpenFrom, themeFor } from '@/lib/monaco'
import { codeFontStack, currentFonts, useFonts } from '@/lib/use-fonts'

/** The line a code link or a "go to definition" named, carried in the trail as `L<n>`. */
export const lineAnchor = (line: number): string => `L${line}`
const parseLineAnchor = (anchor: string | undefined): number | undefined => {
  const match = anchor === undefined ? null : /^L(\d+)$/.exec(anchor)
  return match ? Number(match[1]) : undefined
}

/**
 * The model for one file, shared by every editor showing it. Editors come and go as panes
 * split and close; the model goes when the last of them does.
 */
function acquireModel(worktreeId: string, path: string, text: string): monaco.editor.ITextModel {
  const uri = fileUri(worktreeId, path)
  const existing = monaco.editor.getModel(uri)
  if (existing) {
    if (existing.getValue() !== text) existing.setValue(text)
    return existing
  }
  // The language comes from the extension, as it does in VS Code.
  return monaco.editor.createModel(text, undefined, uri)
}

function releaseModel(model: monaco.editor.ITextModel): void {
  if (!monaco.editor.getEditors().some((editor) => editor.getModel() === model)) model.dispose()
}

/**
 * Stands up one throwaway editor on a scrap of TypeScript, off screen, and disposes it a tick
 * later. Everything the first real editor would otherwise pay for on the click — the editor's
 * own setup, font measurement, the TypeScript worker's start — is paid here, at an idle moment.
 */
export function warmCodeEditor(): void {
  const host = document.createElement('div')
  host.style.cssText = 'position:absolute;left:-10000px;top:0;width:400px;height:200px;overflow:hidden'
  document.body.appendChild(host)
  const model = monaco.editor.createModel('export const warm: number = 1\n', 'typescript', monaco.Uri.parse('inmemory://canopy/warm.ts'))
  const fonts = currentFonts()
  const editor = monaco.editor.create(host, { model, readOnly: true, automaticLayout: false, fontFamily: codeFontStack(fonts), fontLigatures: fonts.ligatures, minimap: { enabled: false } })
  void monaco.typescript.getTypeScriptWorker().catch(() => {})
  setTimeout(() => {
    editor.dispose()
    model.dispose()
    host.remove()
  }, 0)
}

/**
 * The editor measures its font once, when it is created. A bundled font arrives only when
 * something first asks for it, so measure again once it has — otherwise the cursor and the
 * selection sit a fraction of a character off the text.
 */
function remeasureWhenLoaded(family: string): void {
  if (typeof document.fonts?.load !== 'function') return
  document.fonts.load(`12px ${family}`).then(() => monaco.editor.remeasureFonts(), () => {})
}

/**
 * One file in a read-only VS Code editor: its tokens, folding, sticky scroll, find and replace
 * widget (⌘F), go to definition (F12 or ⌘-click), symbols (⇧⌘O), the command palette (F1) and
 * the right-click menu, all the editor's own. Mounted once per file — the host keys it by path.
 */
export default function CodeEditor({
  worktreeId,
  path,
  text,
  mode,
  anchor,
  onOpenPath
}: {
  worktreeId: string
  path: string
  text: string
  mode: 'light' | 'dark'
  anchor?: string
  onOpenPath?: (path: string, hash?: string) => void
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor>(null)
  const openPath = useRef(onOpenPath)
  openPath.current = onOpenPath
  const { fonts } = useFonts()
  const fontFamily = codeFontStack(fonts)

  useEffect(() => {
    const element = host.current
    if (!element) return
    const model = acquireModel(worktreeId, path, text)
    const editor = monaco.editor.create(element, {
      model,
      theme: themeFor(mode),
      readOnly: true,
      domReadOnly: true,
      readOnlyMessage: { value: 'This is a preview; edit the file in your editor.' },
      automaticLayout: true,
      fontFamily,
      fontLigatures: fonts.ligatures,
      fontSize: 12,
      lineHeight: 20,
      lineNumbersMinChars: 3,
      folding: true,
      showFoldingControls: 'mouseover',
      stickyScroll: { enabled: true },
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true },
      scrollbar: { alwaysConsumeMouseWheel: false },
      padding: { top: 8 }
    })
    editorRef.current = editor
    onOpenFrom(editor, (target, line) => openPath.current?.(target, line === undefined ? undefined : lineAnchor(line)))
    return () => {
      editorRef.current = null
      editor.dispose()
      releaseModel(model)
    }
    // Mounted once per file; the text and theme are kept up to date by the effects below.
  }, [worktreeId, path])

  useEffect(() => {
    const model = editorRef.current?.getModel()
    if (model && model.getValue() !== text) model.setValue(text)
  }, [text])

  useEffect(() => {
    monaco.editor.setTheme(themeFor(mode))
  }, [mode])

  useEffect(() => {
    editorRef.current?.updateOptions({ fontFamily, fontLigatures: fonts.ligatures })
    remeasureWhenLoaded(fontFamily)
  }, [fontFamily, fonts.ligatures])

  useEffect(() => {
    const line = parseLineAnchor(anchor)
    const editor = editorRef.current
    if (line === undefined || !editor) return
    editor.revealLineInCenter(line)
    editor.setPosition({ lineNumber: line, column: 1 })
    editor.focus()
  }, [anchor, text])

  return <div ref={host} className="h-full w-full" />
}
