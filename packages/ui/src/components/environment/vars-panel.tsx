import { useState } from 'react'
import { Check, ClipboardCopy, RotateCw } from 'lucide-react'

import type { Worktree } from '@canopy/shared'

import { ErrorNote } from '@/components/error-note'
import { Button } from '@/components/ui/button'
import { useRegenerateEnvFile } from '@/lib/api-hooks'
import { ENV_SOURCE_LABEL, dotenv } from '@/lib/environment-ui'
import { cn } from '@/lib/utils'

/** The resolved environment every service and setup step sees, with secrets masked until clicked. */
export function VarsPanel({ worktree }: { worktree: Worktree }): React.JSX.Element {
  const env = worktree.environment
  const regenerate = useRegenerateEnvFile(worktree.id)
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set())
  const [copied, setCopied] = useState(false)

  // Canopy-injected vars are boilerplate — keep them after the ones the project actually configured.
  const rows = [...env.env].sort((a, b) => Number(a.source === 'canopy') - Number(b.source === 'canopy'))

  const toggle = (key: string): void =>
    setRevealed((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })

  const copyAll = (): void => {
    void navigator.clipboard?.writeText(dotenv(rows)).catch(() => undefined)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="flex flex-col gap-1 px-3 py-2">
      <div className="flex items-center justify-between gap-2 pb-1">
        <span className="font-mono text-[10px] text-muted-foreground">{env.env.length} variables</span>
        <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px] text-muted-foreground" disabled={env.env.length === 0} onClick={copyAll}>
          {copied ? <Check className="size-3" /> : <ClipboardCopy className="size-3" />}
          {copied ? 'copied' : 'copy all'}
        </Button>
      </div>
      {env.env.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">No environment resolved yet — provision the worktree and its ports, databases and overrides land here.</p>
      ) : (
        rows.map((row) => {
          const hidden = row.secret && !revealed.has(row.key)
          return (
            <div key={row.key} className="flex items-center gap-2 font-mono text-[11px]">
              <span className="w-36 shrink-0 truncate text-muted-foreground" title={row.key}>
                {row.key}
              </span>
              {row.secret ? (
                <button
                  type="button"
                  className={cn('min-w-0 flex-1 cursor-pointer truncate text-left', hidden && 'text-muted-foreground')}
                  aria-label={`${hidden ? 'Reveal' : 'Hide'} ${row.key}`}
                  title={hidden ? 'Click to reveal' : 'Click to hide'}
                  onClick={() => toggle(row.key)}
                >
                  {hidden ? '••••••••' : row.value}
                </button>
              ) : (
                <span className="min-w-0 flex-1 truncate" title={row.value}>
                  {row.value}
                </span>
              )}
              <span className="shrink-0 rounded border border-border px-1 text-[9px] text-muted-foreground">{ENV_SOURCE_LABEL[row.source]}</span>
            </div>
          )
        })
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border/60 pt-2">
        <p className="min-w-0 flex-1 text-[10px] text-muted-foreground">
          {env.envFile ? <span className="font-mono">{env.envFile}</span> : 'no env file generated'}
          {env.copiedFiles.length > 0 ? ` · copied ${env.copiedFiles.join(', ')}` : ' · no files copied'}
        </p>
        <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={regenerate.isPending || !env.configured} onClick={() => regenerate.mutate()}>
          {regenerate.isPending ? <RotateCw className="animate-spin" /> : null}
          {regenerate.isPending ? 'Writing…' : `Regenerate ${env.envFile ?? '.env.canopy'}`}
        </Button>
      </div>
      <ErrorNote error={regenerate.error} />
    </div>
  )
}
