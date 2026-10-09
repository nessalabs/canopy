import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { TextQuote } from 'lucide-react'

import { FileIcon } from '@/components/ui/file-icon'
import { toStaged, type AgentContext } from '@/lib/agent-context'

const baseName = (path: string): string => path.split('/').pop() || path

/** What is being dragged, the way its chip will read on arrival: the file's own icon and its name, or the quoted lines. */
function ContextChip({ context }: { context: AgentContext }): React.JSX.Element {
  const { label } = toStaged(context)
  const { path } = context
  const lines = context.kind === 'snippet' ? context.text.split('\n').length : 0
  return (
    <>
      {path ? <FileIcon name={baseName(path)} kind={context.kind === 'path' && context.dir ? 'dir' : 'file'} className="size-4 shrink-0" /> : <TextQuote className="size-4 shrink-0 text-muted-foreground" />}
      <span className="max-w-72 truncate font-mono">{label}</span>
      {lines > 1 ? <span className="shrink-0 text-muted-foreground">{lines} lines</span> : null}
    </>
  )
}

/**
 * Replaces the browser's drag ghost — a bare snapshot of whatever text was grabbed — with a
 * padded chip naming what is on its way. The chip renders synchronously, is handed to
 * `setDragImage`, and is gone again on the next frame; the browser keeps its own bitmap of it.
 */
export function setDragChip(data: DataTransfer, context: AgentContext): void {
  const chip = document.createElement('div')
  chip.className = 'fixed -top-96 left-0 flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-xs font-medium text-foreground shadow-lg'
  document.body.append(chip)
  const root = createRoot(chip)
  flushSync(() => root.render(<ContextChip context={context} />))
  data.setDragImage(chip, 18, 18)
  requestAnimationFrame(() => {
    root.unmount()
    chip.remove()
  })
}
