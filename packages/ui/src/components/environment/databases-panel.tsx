import { useState } from 'react'
import { Check, ChevronDown, Copy, RotateCw } from 'lucide-react'

import { maskUrl, type DbInstanceInfo, type DbStatus, type Worktree } from '@canopy/shared'

import { ErrorNote } from '@/components/error-note'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { StatTile } from '@/components/ui/stat-tile'
import { StatusDot } from '@/components/ui/status-dot'
import { useResetDatabase, useWorktrees } from '@/lib/api-hooks'
import { lineage } from '@/lib/environment-ui'
import { relativeTime } from '@/lib/format'

type DotStatus = 'running' | 'success' | 'error' | 'idle'

const DB_DOT: Record<DbStatus, DotStatus> = {
  pending: 'running',
  forking: 'running',
  ready: 'success',
  error: 'error',
  missing: 'error'
}

/** Adapter facts worth a tile, in the order they read best. */
const DETAIL_KEYS: Array<[key: string, label: string]> = [
  ['container', 'Container'],
  ['file', 'File'],
  ['database', 'Database'],
  ['port', 'Port']
]

function DatabaseCard({ worktree, db }: { worktree: Worktree; db: DbInstanceInfo }): React.JSX.Element {
  const reset = useResetDatabase(worktree.id)
  const worktrees = useWorktrees().data ?? []
  const [copied, setCopied] = useState(false)
  const pending = reset.isPending && reset.variables?.name === db.name
  const busy = pending || db.status === 'forking'
  const siblings = worktrees.filter((wt) => wt.projectId === worktree.projectId && wt.id !== worktree.id)
  const from = lineage(db)

  const copy = (): void => {
    if (!db.connectionUrl) return
    void navigator.clipboard?.writeText(db.connectionUrl).catch(() => undefined)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <StatusDot status={DB_DOT[db.status]} />
        <span className="font-mono text-sm">{db.name}</span>
        <span className="font-mono text-[10px] text-muted-foreground">{db.adapter}</span>
        {busy ? <span className="font-mono text-[10px] text-muted-foreground">forking…</span> : null}
        <span className="ml-auto flex items-center gap-1.5">
          <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={busy} onClick={() => reset.mutate({ name: db.name, from: 'template' })}>
            {pending ? <RotateCw className="animate-spin" /> : null}
            Re-seed
          </Button>
          <Button variant="outline" size="sm" className="h-7 px-2 text-xs text-destructive" disabled={busy} onClick={() => reset.mutate({ name: db.name, from: 'empty' })}>
            Reset
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={busy || siblings.length === 0}>
                Fork from…
                <ChevronDown className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Copy another worktree's fork</DropdownMenuLabel>
              {siblings.map((sibling) => (
                <DropdownMenuItem key={sibling.id} onSelect={() => reset.mutate({ name: db.name, from: { fromWorktree: sibling.id } })}>
                  <span className="font-mono text-xs">{sibling.name}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>
      {db.connectionUrl ? (
        <button
          type="button"
          className="flex cursor-pointer items-center justify-between gap-3 rounded-lg bg-muted/50 px-3 py-2 text-left"
          aria-label={`Copy the ${db.name} connection URL`}
          onClick={copy}
        >
          <span className="truncate font-mono text-xs text-muted-foreground">{maskUrl(db.connectionUrl)}</span>
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            {copied ? 'copied' : 'copy'}
          </span>
        </button>
      ) : (
        <p className="rounded-lg bg-muted/50 px-3 py-2 font-mono text-xs text-muted-foreground">no connection yet</p>
      )}
      <div className="grid grid-cols-2 gap-2 xl:grid-cols-5">
        {DETAIL_KEYS.filter(([key]) => db.detail[key]).map(([key, label]) => (
          <StatTile key={key} label={label} value={db.detail[key]} />
        ))}
        <StatTile label="Size" value={db.sizeMb == null ? '—' : `${db.sizeMb} MB`} />
        <StatTile label="Forked from" value={from.value} hint={from.hint} />
        <StatTile label="Seeded" value={db.seededAt == null ? '—' : relativeTime(db.seededAt)} />
      </div>
      {db.error ? <p className="font-mono text-[11px] text-destructive">{db.error}</p> : null}
      <ErrorNote error={reset.error} />
    </div>
  )
}

/** Each database fork this worktree owns: where it lives, how big it is, and how to reset it. */
export function DatabasesPanel({ worktree }: { worktree: Worktree }): React.JSX.Element {
  const databases = worktree.environment.databases

  if (databases.length === 0) {
    return <p className="px-3 py-6 text-center text-sm text-muted-foreground">canopy.yaml declares no databases.</p>
  }

  return (
    <div className="flex flex-col gap-4 px-3 py-2.5">
      {databases.map((db) => (
        <DatabaseCard key={db.name} worktree={worktree} db={db} />
      ))}
    </div>
  )
}
