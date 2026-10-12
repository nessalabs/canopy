import { ChevronDown, UserRound } from 'lucide-react'

import type { IssueAssignees, IssueFilter } from '@canopy/shared'

import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { SegmentedControl, SegmentedControlOption } from '@/components/ui/segmented-control'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

export const OPEN_ISSUES: IssueFilter = { kind: 'issue', state: 'open' }

const assigneeLabel = (value: string | undefined, viewer: string | null): string => (!value ? 'Anyone' : value === viewer ? 'Me' : value)

/** Who it is assigned to: anyone, the signed-in user, or one of the people anything is assigned to. */
function AssigneeMenu({ assignees: { assignees, viewer }, value, onChange }: { assignees: IssueAssignees; value: string | undefined; onChange: (assignee: string | undefined) => void }): React.JSX.Element {
  const others = assignees.filter((name) => name !== viewer)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" className="h-6 gap-1 rounded-[4px] px-2 text-xs text-muted-foreground data-[state=open]:bg-accent" aria-label="Filter by assignee">
          <UserRound aria-hidden="true" className="size-3.5" />
          {assigneeLabel(value, viewer)}
          <ChevronDown aria-hidden="true" className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto rounded-md">
        <DropdownMenuRadioGroup value={value ?? ''} onValueChange={(next) => onChange(next || undefined)}>
          <DropdownMenuRadioItem value="">Anyone</DropdownMenuRadioItem>
          {viewer ? <DropdownMenuRadioItem value={viewer}>Assigned to me</DropdownMenuRadioItem> : null}
          {others.length > 0 ? <DropdownMenuSeparator /> : null}
          {others.map((name) => (
            <DropdownMenuRadioItem key={name} value={name}>
              {name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Issues or pull requests, open only or closed too. Pressing it keeps focus where it was, so it
 * can sit in the composer's `#` menu without closing the menu it filters.
 */
export function IssueFilterBar({
  filter,
  onChange,
  assignees,
  className
}: {
  filter: IssueFilter
  onChange: (filter: IssueFilter) => void
  /** Given, an assignee menu: anyone, me, or one of the people things are assigned to. */
  assignees?: IssueAssignees
  className?: string
}): React.JSX.Element {
  return (
    <div onMouseDown={(event) => event.preventDefault()} className={cn('flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-2 py-1.5', className)}>
      <SegmentedControl value={filter.kind} onValueChange={(kind) => onChange({ ...filter, kind: kind as IssueFilter['kind'] })} aria-label="Issues or pull requests" className="rounded-md">
        <SegmentedControlOption value="issue" className="h-6 rounded-[4px] px-2 text-xs">
          Issues
        </SegmentedControlOption>
        <SegmentedControlOption value="pr" className="h-6 rounded-[4px] px-2 text-xs">
          Pull requests
        </SegmentedControlOption>
      </SegmentedControl>
      {assignees ? <AssigneeMenu assignees={assignees} value={filter.assignee} onChange={(assignee) => onChange({ ...filter, assignee })} /> : null}
      <label className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Switch checked={filter.state === 'all'} onCheckedChange={(all) => onChange({ ...filter, state: all ? 'all' : 'open' })} aria-label="Show closed" />
        Show closed
      </label>
    </div>
  )
}
