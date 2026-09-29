import { useEffect, useRef } from 'react'

import type { LineChange, LineChangeKind } from '@/lib/line-changes'
import { fileUri, monaco, onOpenFrom, themeFor } from '@/lib/monaco'
import { codeFontStack, currentFonts, useFonts } from '@/lib/use-fonts'

import './code-editor.css'

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

/** How each kind of change is painted; the classes live in code-editor.css. */
const MARK: Record<Exclude<LineChangeKind, 'removed'>, { line: string; gutter: string; ruler: string }> = {
  added: { line: 'canopy-line-added', gutter: 'canopy-gutter-added', ruler: '#3fb950' },
  modified: { line: 'canopy-line-modified', gutter: 'canopy-gutter-modified', ruler: '#d29922' }
}
const REMOVED_RULER = '#f85149'

/** The patch's changes as editor decorations: a gutter bar and a line wash, and a notch for a cut. */
function markChanges(changes: LineChange[], lineCount: number): monaco.editor.IModelDeltaDecoration[] {
  // A mark past the end means the text and the patch disagree for a moment; skip it rather than guess.
  return changes.filter((change) => change.kind === 'removed' || change.start <= lineCount).map((change) => {
    if (change.kind === 'removed') {
      // Lines cut from the end of the file sit below the last line, not above a line that is not there.
      const below = change.start > lineCount
      const line = Math.min(change.start, lineCount)
      return {
        range: new monaco.Range(line, 1, line, 1),
        options: {
          linesDecorationsClassName: below ? 'canopy-gutter-removed-below' : 'canopy-gutter-removed',
          overviewRuler: { color: REMOVED_RULER, position: monaco.editor.OverviewRulerLane.Left }
        }
      }
    }
    const mark = MARK[change.kind]
    return {
      range: new monaco.Range(change.start, 1, Math.min(change.end, lineCount), 1),
      options: {
        isWholeLine: true,
        className: mark.line,
        linesDecorationsClassName: mark.gutter,
        overviewRuler: { color: mark.ruler, position: monaco.editor.OverviewRulerLane.Left }
      }
    }
  })
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
  changes,
  onOpenPath
}: {
  worktreeId: string
  path: string
  text: string
  mode: 'light' | 'dark'
  anchor?: string
  /** What the change being reviewed did to this file's lines, marked in the gutter; absent outside a diff. */
  changes?: LineChange[]
  onOpenPath?: (path: string, hash?: string) => void
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor>(null)
  const marksRef = useRef<monaco.editor.IEditorDecorationsCollection>(null)
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
    marksRef.current = editor.createDecorationsCollection()
    onOpenFrom(editor, (target, line) => openPath.current?.(target, line === undefined ? undefined : lineAnchor(line)))
    return () => {
      editorRef.current = null
      marksRef.current = null
      editor.dispose()
      releaseModel(model)
    }
    // Mounted once per file; the text and theme are kept up to date by the effects below.
  }, [worktreeId, path])

  useEffect(() => {
    const model = editorRef.current?.getModel()
    if (model && model.getValue() !== text) model.setValue(text)
  }, [text])

  // After the text effect above, so the marks are laid over the lines they were computed for.
  useEffect(() => {
    const model = editorRef.current?.getModel()
    if (!model || !marksRef.current) return
    marksRef.current.set(changes ? markChanges(changes, model.getLineCount()) : [])
  }, [changes, text])

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
