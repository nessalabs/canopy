import { X } from 'lucide-react'

import { cn } from '@/lib/utils'

/** The frame every drawer beside the canvas shares: a title, a close button, a scrolling body and an optional footer. */
export function Drawer({
  label,
  title,
  onClose,
  footer,
  children,
  className
}: {
  label: string
  title: React.ReactNode
  onClose: () => void
  footer?: React.ReactNode
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <aside aria-label={label} className={cn('flex h-full min-h-0 flex-col border-l border-border bg-background', className)}>
      <header className="flex items-start gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">{title}</div>
        <button type="button" aria-label="Close" onClick={onClose} className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-4">
          <X />
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-4">{children}</div>
      {footer ? <footer className="border-t border-border px-4 py-3">{footer}</footer> : null}
    </aside>
  )
}
