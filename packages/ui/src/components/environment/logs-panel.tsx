import { PROVISION_LOG, type Worktree } from '@canopy/shared'

import { SegmentedControl, SegmentedControlOption } from '@/components/ui/segmented-control'

import { LogsView } from './logs-view'

/** The services whose output can be tailed, plus Canopy's own provisioning log. */
export function loggableServices(worktree: Worktree): string[] {
  return [...worktree.environment.services.filter((service) => !service.excluded).map((service) => service.name), PROVISION_LOG]
}

/**
 * Log output for one stream at a time. The selection lives on the screen so the Services
 * panel's "Logs" buttons can switch this panel instead of opening a second one.
 */
export function LogsPanel({ worktree, service, onServiceChange }: { worktree: Worktree; service: string; onServiceChange: (service: string) => void }): React.JSX.Element {
  const options = loggableServices(worktree)
  const selected = options.includes(service) ? service : (options[0] ?? PROVISION_LOG)

  return (
    <div className="flex h-full min-h-0 flex-col px-3 py-2">
      <LogsView
        worktreeId={worktree.id}
        service={selected}
        toolbarLeading={
          options.length > 1 ? (
            <SegmentedControl value={selected} onValueChange={onServiceChange} aria-label="Log stream">
              {options.map((name) => (
                <SegmentedControlOption key={name} value={name}>
                  <span className="font-mono text-xs">{name}</span>
                </SegmentedControlOption>
              ))}
            </SegmentedControl>
          ) : (
            <span className="font-mono text-xs text-muted-foreground">{selected}</span>
          )
        }
      />
    </div>
  )
}
