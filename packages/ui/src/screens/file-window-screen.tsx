import { useEffect, useState } from 'react'
import { useLocation } from 'wouter'

import { FilePane } from '@/components/git/content-pane'
import { fileWindowHash } from '@/lib/pop-out'

/**
 * One file, alone in its own window — what "open in a new window" opens. It is the same pane
 * the browser shows, so links inside a rendered doc keep working; they navigate this window
 * rather than the one it was opened from, which is the point of having two.
 */
export function FileWindowScreen({ worktreeId, path, rev }: { worktreeId: string; path: string; rev?: string }): React.JSX.Element {
  const [, navigate] = useLocation()
  const [anchor, setAnchor] = useState<string>()
  // How many files deep the trail is, so Back is offered only where there is something behind.
  const [depth, setDepth] = useState(0)

  useEffect(() => {
    document.title = path
  }, [path])

  return (
    // The diagram surface: an expanded diagram fills this window rather than covering it.
    <div data-diagram-surface className="relative h-dvh overflow-hidden bg-background">
      <FilePane
        worktreeId={worktreeId}
        path={path}
        rev={rev}
        anchor={anchor}
        onOpenPath={(next, hash) => {
          setAnchor(hash)
          setDepth((current) => current + 1)
          navigate(fileWindowHash(worktreeId, next, rev))
        }}
        onBack={
          depth === 0
            ? undefined
            : () => {
                setDepth((current) => Math.max(0, current - 1))
                history.back()
              }
        }
      />
    </div>
  )
}
