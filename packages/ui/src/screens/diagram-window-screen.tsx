import { useEffect, useMemo } from 'react'

import { CodeBlockProvider } from '@/components/ui/code-block'
import { MermaidDiagram } from '@/components/ui/mermaid-diagram'
import { readDiagram } from '@/lib/pop-out'
import { useTheme } from '@/lib/use-theme'

/**
 * One diagram, alone in its own window — pan and zoom it beside the doc it came from. The
 * source was stashed by the window that opened this one; a reload finds it again, and a window
 * restored days later (or on another machine) finds nothing and says so.
 */
export function DiagramWindowScreen({ id }: { id: string }): React.JSX.Element {
  const { theme } = useTheme()
  const chart = useMemo(() => readDiagram(id), [id])

  useEffect(() => {
    document.title = 'Diagram'
  }, [])

  if (chart === null) {
    return <p className="p-4 font-mono text-[11px] text-muted-foreground">This diagram is no longer available. Open it again from the doc it lives in.</p>
  }

  return (
    <CodeBlockProvider mode={theme}>
      {/* The window is the viewer: it opens expanded, filling this surface rather than the screen. */}
      <div data-diagram-surface className="relative h-dvh overflow-hidden bg-background">
        <MermaidDiagram chart={chart} defaultExpanded className="h-full" />
      </div>
    </CodeBlockProvider>
  )
}
