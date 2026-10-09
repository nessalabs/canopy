import { useEffect } from 'react'

import { CONTEXT_MIME, type AgentContext } from './agent-context'

/**
 * Selections that may sit inside a shadow root. The diff renderer draws into one, and there the
 * document's own selection only sees the shadow host; Chromium's `ShadowRoot.getSelection` sees
 * the real range. Elsewhere this is just `document.getSelection()`.
 */
export function selectionAt(event: Event): Selection | null {
  const inner = event.composedPath()[0]
  const root = inner instanceof Node ? inner.getRootNode() : null
  const shadow = root instanceof ShadowRoot && 'getSelection' in root ? (root as ShadowRoot & { getSelection: () => Selection | null }).getSelection() : null
  return shadow && !shadow.isCollapsed ? shadow : document.getSelection()
}

/** The element a node sits in, or the shadow host for a node at the top of a shadow root. */
const parentAcross = (node: Node): Element | null => {
  const root = node.getRootNode()
  return node.parentElement ?? (root instanceof ShadowRoot ? root.host : null)
}

/** The nearest `selector` match at or above `node`, climbing out of shadow roots on the way. */
export function closestAcross(node: Node | null, selector: string): Element | null {
  let element = node instanceof Element ? node : node && parentAcross(node)
  while (element) {
    const found = element.closest(selector)
    if (found) return found
    const root = element.getRootNode()
    element = root instanceof ShadowRoot ? root.host : null
  }
  return null
}

/** Whether `host` holds `node`, counting what sits inside shadow roots beneath it. */
export function containsAcross(host: Element, node: Node): boolean {
  let current: Node = node
  for (let root = current.getRootNode(); root instanceof ShadowRoot; root = current.getRootNode()) current = root.host
  return host.contains(current)
}

const lineOf = (node: Node): number | undefined => {
  const line = Number(closestAcross(node, '[data-line]')?.getAttribute('data-line'))
  return Number.isInteger(line) && line > 0 ? line : undefined
}

/**
 * Where a selected piece of code comes from: the file of the pane it is in (`data-file-path`)
 * and the line numbers of its first and last rows (`data-line`, as the diff renderer marks them).
 */
export function snippetSource(range: Range): { path?: string; lines?: [number, number] } {
  const path = closestAcross(range.startContainer, '[data-file-path]')?.getAttribute('data-file-path') ?? undefined
  const from = lineOf(range.startContainer)
  const to = lineOf(range.endContainer)
  return { ...(path ? { path } : {}), ...(from && to ? { lines: [Math.min(from, to), Math.max(from, to)] as [number, number] } : {}) }
}

/**
 * Highlighted text dragged out of `host` carries where it came from, so a drop on an agent
 * stages it as `path:lines` rather than as loose text. Draggable elements set their own data.
 * `decorate` gets the drag too — to give it a ghost image of its own.
 */
export function useSnippetDrag(host: React.RefObject<HTMLElement | null>, decorate?: (data: DataTransfer, context: AgentContext) => void): void {
  useEffect(() => {
    const element = host.current
    if (!element) return
    const start = (event: DragEvent): void => {
      if (!event.dataTransfer || (event.target instanceof Element && event.target.closest('[draggable="true"]'))) return
      const selection = selectionAt(event)
      const text = selection?.toString().trim()
      if (!selection || !text || selection.rangeCount === 0) return
      const context: AgentContext = { kind: 'snippet', text, ...snippetSource(selection.getRangeAt(0)) }
      event.dataTransfer.setData(CONTEXT_MIME, JSON.stringify(context))
      decorate?.(event.dataTransfer, context)
    }
    element.addEventListener('dragstart', start)
    return () => element.removeEventListener('dragstart', start)
  }, [host])
}
