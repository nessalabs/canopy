import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import CssWorker from 'monaco-editor/languages/features/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/languages/features/html/html.worker?worker'
import JsonWorker from 'monaco-editor/languages/features/json/json.worker?worker'
import TsWorker from 'monaco-editor/languages/features/typescript/ts.worker?worker'

/**
 * The editor VS Code is built on, set up once for Canopy: its language workers bundled by
 * Vite, a theme for each side of the app's palette, and cross-file navigation routed back into
 * the file panes. Everything a source file gets in the browser — find, folding, go to
 * definition, symbols, the command palette — comes from here rather than being rebuilt.
 */

self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case 'json':
        return new JsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker()
      case 'typescript':
      case 'javascript':
        return new TsWorker()
      default:
        return new EditorWorker()
    }
  }
}

// A preview of one file cannot see the rest of the project, so its imports would all be
// "unresolved": no diagnostics. Navigation and hovers still work, and every open file is
// synced to the worker so a definition in another open pane resolves too.
for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
  defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true })
  defaults.setEagerModelSync(true)
}

// Matched to the pane's `bg-card` on each side of the palette, so the editor sits flush.
monaco.editor.defineTheme('canopy-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#171717',
    'editorGutter.background': '#171717',
    'editorLineNumber.foreground': '#6b6b6b',
    'editorLineNumber.activeForeground': '#a1a1a1',
    'editorStickyScroll.background': '#171717',
    'editorStickyScroll.shadow': '#00000000'
  }
})
monaco.editor.defineTheme('canopy-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#ffffff',
    'editorGutter.background': '#ffffff',
    'editorLineNumber.foreground': '#a3a3a3',
    'editorLineNumber.activeForeground': '#525252',
    'editorStickyScroll.background': '#ffffff',
    'editorStickyScroll.shadow': '#00000000'
  }
})

export const themeFor = (mode: 'light' | 'dark'): string => (mode === 'dark' ? 'canopy-dark' : 'canopy-light')

/** Where a worktree's file lives in the editor: the worktree keeps two checkouts' files apart. */
export const fileUri = (worktreeId: string, path: string): monaco.Uri => monaco.Uri.from({ scheme: 'file', path: `/${worktreeId}/${path}` })

/** Reads back what `fileUri` wrote, or null for a uri that is not one of ours. */
export function filePathOf(uri: monaco.Uri): { worktreeId: string; path: string } | null {
  const match = /^\/([^/]+)\/(.+)$/.exec(uri.path)
  return uri.scheme === 'file' && match ? { worktreeId: match[1], path: match[2] } : null
}

/** Opens a file at a line, in the pane the navigation started from. */
export type OpenFileAt = (path: string, line?: number) => void

const openers = new WeakMap<monaco.editor.ICodeEditor, OpenFileAt>()

/** Registers how this editor's pane opens another file, for as long as the editor lives. */
export function onOpenFrom(editor: monaco.editor.ICodeEditor, open: OpenFileAt): void {
  openers.set(editor, open)
}

// "Go to definition" into another file: the editor cannot show it, so the pane that holds
// the editor opens that file instead, with Back leading here — the same trail a doc link uses.
monaco.editor.registerEditorOpener({
  openCodeEditor(source, resource, selectionOrPosition) {
    const open = openers.get(source)
    const target = filePathOf(resource)
    if (!open || !target) return false
    const line = selectionOrPosition === undefined ? undefined : 'startLineNumber' in selectionOrPosition ? selectionOrPosition.startLineNumber : selectionOrPosition.lineNumber
    open(target.path, line)
    return true
  }
})

export { monaco }
