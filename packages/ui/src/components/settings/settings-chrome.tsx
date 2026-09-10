/** Small shared pieces every settings tab uses: labelled rows, the scope strip, the autosave badge. */
import { Check, Loader2, TriangleAlert, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import type { SaveStatus } from './use-draft-settings'

/** A labelled control with an optional hint above it. */
export function Row({ label, hint, children, className }: { label: string; hint?: string; children: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div>
        <p className="text-sm font-medium">{label}</p>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      {children}
    </div>
  )
}

/** A short "where does this live" strip at the top of a tab. */
export function ScopeNote({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground [&_code]:font-mono [&_code]:text-foreground">{children}</div>
}

const STATUS_TEXT: Record<SaveStatus, string> = { idle: '', saving: 'Saving…', saved: 'Saved', error: "Couldn't save" }

/** The autosave indicator in a tab header. Silent while nothing has happened yet. */
export function SaveIndicator({ status }: { status: SaveStatus }): React.JSX.Element | null {
  if (status === 'idle') return null
  return (
    <span
      role="status"
      className={cn('flex items-center gap-1 text-xs', status === 'error' ? 'text-destructive' : 'text-muted-foreground')}
    >
      {status === 'saving' ? <Loader2 className="size-3 animate-spin" /> : null}
      {status === 'saved' ? <Check className="size-3 text-nessa-diff-addition" /> : null}
      {status === 'error' ? <TriangleAlert className="size-3" /> : null}
      {STATUS_TEXT[status]}
    </span>
  )
}

/** The little × that drops a row from a list editor. */
export function RemoveButton({ label, onClick }: { label: string; onClick: () => void }): React.JSX.Element {
  return (
    <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" aria-label={label} onClick={onClick}>
      <X className="size-3.5" />
    </Button>
  )
}

/** The header line of a tab: title, optional description, autosave state on the right. */
export function TabHeader({ title, description, status, action }: { title: string; description?: string; status?: SaveStatus; action?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border/60 pb-3">
      <div>
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <div className="flex items-center gap-2">
        {action}
        {status ? <SaveIndicator status={status} /> : null}
      </div>
    </div>
  )
}
