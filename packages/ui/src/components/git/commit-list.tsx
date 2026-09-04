import type { Commit } from '@canopy/shared'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { RandomAvatar } from '@/components/ui/random-avatar'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { absoluteTime, relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'

/** The History list: one row per commit, GitHub-Desktop style. */
export function CommitList({
  commits,
  selected,
  onSelect,
  hasMore,
  loadingMore,
  onLoadMore
}: {
  commits: Commit[]
  selected?: string
  onSelect: (sha: string) => void
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
}): React.JSX.Element {
  return (
    <ScrollArea className="h-full">
      <ul className="flex flex-col" role="listbox" aria-label="Commits">
        {commits.map((commit) => (
          <li key={commit.sha}>
            <button
              type="button"
              role="option"
              aria-selected={commit.sha === selected}
              className={cn(
                'flex w-full items-start gap-2.5 border-b border-border/60 px-3 py-2 text-left transition-colors hover:bg-accent/50',
                commit.sha === selected && 'bg-accent'
              )}
              onClick={() => onSelect(commit.sha)}
            >
              <RandomAvatar seed={commit.email} name={commit.author} className="mt-0.5 size-6 shrink-0 rounded-full" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm">{commit.subject}</span>
                <span className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
                  <span className="truncate">{commit.author}</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="shrink-0">{relativeTime(commit.at)}</span>
                    </TooltipTrigger>
                    <TooltipContent>{absoluteTime(commit.at)}</TooltipContent>
                  </Tooltip>
                  {commit.parents.length > 1 ? <span className="shrink-0">· merge</span> : null}
                </span>
              </span>
              <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
                {commit.shortSha}
              </Badge>
            </button>
          </li>
        ))}
      </ul>
      {hasMore ? (
        <div className="p-2">
          <Button variant="ghost" size="sm" className="w-full text-xs" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? 'Loading…' : 'Load more commits'}
          </Button>
        </div>
      ) : null}
    </ScrollArea>
  )
}
