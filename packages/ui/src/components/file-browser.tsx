import { useState } from 'react'

import { FileViewer } from '@/components/git/file-viewer'
import { WorktreeTree } from '@/components/git/file-tree'
import { SplitView, SplitViewOrientation, SplitViewPanel, SplitViewSeparator } from '@/components/split-view'
import { FileDiffPath } from '@/components/ui/file-diff-list'

/** The whole worktree in the side panel: lazy tree on top, the picked file's contents below. */
export function FileBrowser({ worktreeId }: { worktreeId: string }): React.JSX.Element {
  const [selected, setSelected] = useState<string>()
  return (
    <SplitView orientation={SplitViewOrientation.Vertical} className="h-full">
      <SplitViewPanel id="tree" defaultSize={40} minSize={15} className="min-h-0 border-b border-border">
        <WorktreeTree worktreeId={worktreeId} selected={selected} onSelect={setSelected} className="h-full" />
      </SplitViewPanel>
      <SplitViewSeparator />
      <SplitViewPanel id="file" minSize={20} className="flex min-h-0 flex-col">
        {selected ? (
          <>
            <FileDiffPath path={selected} className="shrink-0 border-b border-border bg-muted/30 px-3 py-1.5 font-mono text-xs" />
            <div className="min-h-0 flex-1 overflow-auto">
              <FileViewer worktreeId={worktreeId} path={selected} />
            </div>
          </>
        ) : (
          <p className="p-3 font-mono text-[11px] text-muted-foreground">Pick a file to read it.</p>
        )}
      </SplitViewPanel>
    </SplitView>
  )
}
