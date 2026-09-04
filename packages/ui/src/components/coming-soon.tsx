import { Construction } from 'lucide-react'

/** Placeholder for tabs whose backend lands in a later iteration. */
export function ComingSoon({ title, detail }: { title: string; detail: string }): React.JSX.Element {
  return (
    <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border p-8 text-center">
      <Construction className="size-5 text-muted-foreground" />
      <p className="text-sm font-medium">{title} — coming soon</p>
      <p className="max-w-sm text-xs text-muted-foreground">{detail}</p>
    </div>
  )
}
