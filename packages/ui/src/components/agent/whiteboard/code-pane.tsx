import { FileCode2 } from 'lucide-react'

import { FileViewer } from '@/components/git/file-viewer'
import { refTarget } from '@/lib/whiteboard'

/** The code a box cites, read beside the whiteboard: the file, landed on the lines the box names. */
export function CodePane({ worktreeId, codeRef }: { worktreeId: string; codeRef?: string }): React.JSX.Element {
  if (!codeRef) return <p className="p-4 text-xs text-muted-foreground">Pick a box on the whiteboard and open one of its files to read the code here.</p>
  const { path, lines } = refTarget(codeRef)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 truncate font-mono" title={codeRef}>
          {path}
        </span>
        {lines ? <span className="shrink-0 text-muted-foreground">lines {lines}</span> : null}
      </header>
      <div className="min-h-0 flex-1">
        <FileViewer key={codeRef} worktreeId={worktreeId} path={path} anchor={lines ? `L${lines.split('-')[0]}` : undefined} />
      </div>
    </div>
  )
}
