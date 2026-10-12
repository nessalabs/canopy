import type { IssueFilter } from '@canopy/shared'

import { SegmentedControl, SegmentedControlOption } from '@/components/ui/segmented-control'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

export const OPEN_ISSUES: IssueFilter = { kind: 'issue', state: 'open' }

/**
 * Issues or pull requests, open only or closed too. Pressing it keeps focus where it was, so it
 * can sit in the composer's `#` menu without closing the menu it filters.
 */
export function IssueFilterBar({ filter, onChange, className }: { filter: IssueFilter; onChange: (filter: IssueFilter) => void; className?: string }): React.JSX.Element {
  return (
    <div onMouseDown={(event) => event.preventDefault()} className={cn('flex shrink-0 items-center gap-3 border-b border-border px-2 py-1.5', className)}>
      <SegmentedControl value={filter.kind} onValueChange={(kind) => onChange({ ...filter, kind: kind as IssueFilter['kind'] })} aria-label="Issues or pull requests" className="rounded-md">
        <SegmentedControlOption value="issue" className="h-6 rounded-[4px] px-2 text-xs">
          Issues
        </SegmentedControlOption>
        <SegmentedControlOption value="pr" className="h-6 rounded-[4px] px-2 text-xs">
          Pull requests
        </SegmentedControlOption>
      </SegmentedControl>
      <label className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Switch checked={filter.state === 'all'} onCheckedChange={(all) => onChange({ ...filter, state: all ? 'all' : 'open' })} aria-label="Show closed" />
        Show closed
      </label>
    </div>
  )
}
