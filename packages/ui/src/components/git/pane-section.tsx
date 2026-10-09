import { FileDiffPath } from '@/components/ui/file-diff-list'
import { FileIcon } from '@/components/ui/file-icon'
import { plural } from '@/lib/format'

type Icon = React.ComponentType<{ className?: string }>

/** A titled block of the Comments pane: icon, title, a count, a one-line summary, and its actions. */
export function PaneSection({
  icon: Icon,
  title,
  count,
  summary,
  actions,
  children
}: {
  icon: Icon
  title: string
  count: number
  summary?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-3">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex size-7 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-3.5" />
        </span>
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">{count}</span>
        {summary ? <span className="text-xs text-muted-foreground">{summary}</span> : null}
        {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
      </header>
      {children}
    </section>
  )
}

/** A file's comments as one card, headed by the file. */
export function FileGroup({ file, count, noun, children }: { file: string; count: number; noun: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card/40">
      <h4 className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-xs">
        <FileIcon name={file} />
        <FileDiffPath path={file} className="min-w-0 flex-1 font-mono" />
        <span className="text-muted-foreground">{plural(count, noun)}</span>
      </h4>
      <ul className="flex flex-col p-1">{children}</ul>
    </div>
  )
}

/** What an empty section says: what would be here, and how to get some. */
export function EmptySection({ icon: Icon, title, hint }: { icon: Icon; title: string; hint: string }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-8 text-center">
      <Icon className="size-5 text-muted-foreground/70" />
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-sm text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}
