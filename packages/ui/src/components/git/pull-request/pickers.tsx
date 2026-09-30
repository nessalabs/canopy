import { useEffect, useMemo, useState } from 'react'
import { Pencil, Search } from 'lucide-react'
import { Popover } from 'radix-ui'

import type { PullRequestOptions } from '@canopy/shared'

import { ErrorNote } from '@/components/error-note'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { PopoverSurface } from '@/components/ui/popover-surface'
import { usePullRequestOptions } from '@/lib/api-hooks'
import { cn } from '@/lib/utils'

import { GitHubAvatar } from './parts'

export interface Choice {
  id: string
  label: string
  detail?: string | null
  /** A swatch beside the label (labels have colours). */
  color?: string
  /** A GitHub login whose picture goes beside the label. */
  avatar?: string
}

/**
 * GitHub's sidebar gear: a searchable list of choices with the current ones ticked. Changes are
 * gathered while the popover is open and sent as one edit when it closes, so ticking three
 * people is one request, not three.
 */
export function SidePicker({
  worktreeId,
  host,
  title,
  choices,
  selected,
  single,
  allowCustom,
  onCommit,
  disabled
}: {
  worktreeId: string
  /** The GitHub host, for avatars. */
  host: string | null
  title: string
  choices: (options: PullRequestOptions) => Choice[]
  /** Ids currently on the PR. */
  selected: string[]
  /** One at a time, with a "none" row (the milestone). */
  single?: boolean
  /** Lets a typed value be picked as it is (a team slug like `org/team`). */
  allowCustom?: (query: string) => Choice | null
  onCommit: (add: string[], remove: string[]) => void
  disabled?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set(selected))
  const options = usePullRequestOptions(worktreeId, open)
  const all = useMemo(() => (options.data ? choices(options.data) : []), [options.data, choices])

  useEffect(() => {
    if (open) {
      setPicked(new Set(selected))
      setQuery('')
    }
  }, [open])

  const close = (next: boolean): void => {
    setOpen(next)
    if (next) return
    const before = new Set(selected)
    const add = [...picked].filter((id) => !before.has(id))
    const remove = selected.filter((id) => !picked.has(id))
    if (add.length || remove.length) onCommit(add, remove)
  }

  const needle = query.trim().toLowerCase()
  const shown = all.filter((choice) => !needle || choice.id.toLowerCase().includes(needle) || (choice.label + ' ' + (choice.detail ?? '')).toLowerCase().includes(needle))
  const custom = allowCustom && needle && !all.some((choice) => choice.id.toLowerCase() === needle) ? allowCustom(query.trim()) : null
  const rows = custom ? [custom, ...shown] : shown

  const toggle = (id: string): void =>
    setPicked((current) => {
      if (single) return current.has(id) ? new Set() : new Set([id])
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <Popover.Root open={open} onOpenChange={close}>
      <Popover.Trigger asChild>
        <Button variant="ghost" size="icon" className="size-6 text-muted-foreground" aria-label={`Edit ${title.toLowerCase()}`} disabled={disabled}>
          <Pencil className="size-3.5" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content asChild side="left" align="start" sideOffset={6} collisionPadding={8}>
          <PopoverSurface className="flex w-[min(92vw,20rem)] flex-col p-0">
            <label className="flex items-center gap-2 border-b border-border px-3 py-2">
              <Search className="size-3.5 text-muted-foreground" />
              <input className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" placeholder={`Search ${title.toLowerCase()}`} value={query} onChange={(event) => setQuery(event.target.value)} autoFocus />
            </label>
            <div className="max-h-72 overflow-y-auto p-1">
              {options.isPending ? <p className="px-2 py-3 font-mono text-xs text-muted-foreground">Asking GitHub…</p> : null}
              <ErrorNote error={options.error} className="px-2 py-2" />
              {single && options.data ? (
                <Row label="None" checked={picked.size === 0} onToggle={() => setPicked(new Set())} />
              ) : null}
              {rows.map((choice) => (
                <Row key={choice.id} label={choice.label} detail={choice.detail} color={choice.color} avatar={choice.avatar} host={host} checked={picked.has(choice.id)} onToggle={() => toggle(choice.id)} />
              ))}
              {options.data && rows.length === 0 ? <p className="px-2 py-3 text-xs text-muted-foreground">Nothing matches.</p> : null}
            </div>
            <p className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">Applied when this closes.</p>
          </PopoverSurface>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function Row({
  label,
  detail,
  color,
  avatar,
  host,
  checked,
  onToggle
}: {
  label: string
  detail?: string | null
  color?: string
  avatar?: string
  host?: string | null
  checked: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <label className={cn('flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-accent/50', checked && 'bg-accent/30')}>
      <Checkbox checked={checked} onChange={onToggle} />
      {avatar ? <GitHubAvatar login={avatar} name={detail} host={host ?? null} className="size-5 shrink-0 rounded-full" /> : null}
      {color ? <span className="size-3 shrink-0 rounded-full border" style={{ backgroundColor: `#${color}`, borderColor: `#${color}` }} /> : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail ? <span className="min-w-0 truncate text-xs text-muted-foreground">{detail}</span> : null}
    </label>
  )
}
