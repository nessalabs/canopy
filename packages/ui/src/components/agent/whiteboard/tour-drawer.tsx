import { useEffect } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { TourStep } from '@/lib/whiteboard'

import { Drawer } from './drawer'

/**
 * The walk-through, in the sidebar: the plan read out one step at a time — each board's opening,
 * then each of its boxes in plain words — while the canvas follows and lights the box up. Arrow
 * keys step.
 */
export function TourDrawer({ steps, index, onIndex, onClose, className }: { steps: readonly TourStep[]; index: number; onIndex: (index: number) => void; onClose: () => void; className?: string }): React.JSX.Element | null {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, [contenteditable="true"]')) return
      if (event.key === 'ArrowRight' && index < steps.length - 1) onIndex(index + 1)
      else if (event.key === 'ArrowLeft' && index > 0) onIndex(index - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, steps.length])
  const step = steps[index]
  if (!step) return null
  return (
    <Drawer
      label="Walk-through"
      title={
        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold">Walk me through</p>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {index + 1} of {steps.length}
            </span>
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-foreground/60 transition-[width]" style={{ width: `${((index + 1) / steps.length) * 100}%` }} />
            </div>
          </div>
        </div>
      }
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" disabled={index === 0} onClick={() => onIndex(index - 1)}>
            <ChevronLeft /> Back
          </Button>
          {index < steps.length - 1 ? (
            <Button size="sm" onClick={() => onIndex(index + 1)}>
              Next <ChevronRight />
            </Button>
          ) : (
            <Button size="sm" onClick={onClose}>
              Done
            </Button>
          )}
        </div>
      }
      className={className}
    >
      <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{step.box ? 'A part of the board' : 'A new board'}</p>
      <p className="-mt-3 text-base font-semibold">{step.title}</p>
      <p className="text-sm leading-relaxed">{step.text}</p>
    </Drawer>
  )
}
