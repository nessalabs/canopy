import { RotateCw, Sparkles } from 'lucide-react'

import { Button } from '@/components/ui/button'

/** "Draft with Claude", for the commit box and the new-PR form. Spins while a draft is on its way. */
export function DraftButton({
  running,
  blocked,
  compact = false,
  onClick
}: {
  running: boolean
  /** Why there is nothing to draft yet; disables the button and becomes its tooltip. */
  blocked?: string
  /** Icon only, for the narrow commit box. */
  compact?: boolean
  onClick: () => void
}): React.JSX.Element {
  const label = running ? 'Drafting…' : 'Draft with Claude'
  return (
    <Button
      type="button"
      variant="outline"
      size={compact ? 'icon' : 'sm'}
      className={compact ? 'size-8' : 'w-fit'}
      disabled={running || blocked !== undefined}
      title={blocked ?? label}
      aria-label={label}
      onClick={onClick}
    >
      {running ? <RotateCw className="animate-spin" /> : <Sparkles />}
      {compact ? null : label}
    </Button>
  )
}
