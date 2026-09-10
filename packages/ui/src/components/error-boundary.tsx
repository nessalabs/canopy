import { Component, type ErrorInfo, type ReactNode } from 'react'
import { RotateCw, TriangleAlert } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { errorMessage } from '@/components/error-note'
import { cn } from '@/lib/utils'

interface Props {
  children: ReactNode
  /** Named in the fallback so the reader knows which region failed ("Databases", "this screen"). */
  label?: string
  /** Changing it clears the error — the router passes the location, panels their view id. */
  resetKey?: unknown
  className?: string
}

interface State {
  error: Error | null
}

/**
 * Contains a render crash to one region. React unmounts the whole tree when a render throws,
 * so without a boundary a single unexpected field — a `null` the daemon never sent — leaves an
 * empty window with no way back. Each pane and the routed screen get one, so the rest of the
 * app stays usable and the message says what actually broke.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[canopy] ${this.props.label ?? 'render'} failed`, error, info.componentStack)
  }

  componentDidUpdate(previous: Props): void {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div role="alert" className={cn('flex min-w-0 flex-col items-start gap-2 p-4', this.props.className)}>
        <p className="flex items-center gap-1.5 text-sm font-medium text-destructive">
          <TriangleAlert className="size-4 shrink-0" />
          {this.props.label ? `${this.props.label} failed to render` : 'Something failed to render'}
        </p>
        <p className="max-w-full font-mono text-[11px] break-words whitespace-pre-wrap text-muted-foreground">{errorMessage(error)}</p>
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => this.setState({ error: null })}>
          <RotateCw className="size-3.5" />
          Try again
        </Button>
      </div>
    )
  }
}
