import { useEffect, useState } from 'react'

import { AgentAvatar } from '@/components/agent/agent-avatar'
import { cn } from '@/lib/utils'

/** Only drags that carry something to read; a file from the desktop is not one. */
export const carriesContext = (data: DataTransfer | null): boolean => data !== null && !data.types.includes('Files') && data.types.length > 0

const outsideWindow = (event: DragEvent): boolean => event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight

/**
 * Whether something droppable is being dragged anywhere in the window, so the panel can invite
 * the drop before the pointer reaches it. Drags from Canopy end with `dragend`; text dragged in
 * from another app never does, so leaving the window or dropping anywhere ends it too.
 */
export function useDragAnywhere(): { dragging: boolean; done: () => void } {
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    const start = (event: DragEvent): void => {
      if (event.type === 'dragstart' || carriesContext(event.dataTransfer)) setDragging(true)
    }
    const end = (): void => setDragging(false)
    const leave = (event: DragEvent): void => {
      if (outsideWindow(event)) setDragging(false)
    }
    const events: [string, (event: DragEvent) => void][] = [['dragstart', start], ['dragenter', start], ['dragend', end], ['drop', end], ['dragleave', leave]]
    for (const [name, handler] of events) document.addEventListener(name, handler as EventListener)
    return () => {
      for (const [name, handler] of events) document.removeEventListener(name, handler as EventListener)
    }
  }, [])
  return { dragging, done: () => setDragging(false) }
}

/**
 * Where a drag lands, shown over the conversation for as long as anything droppable is in the
 * air: a quiet invitation while it is elsewhere, lit up once it is over the panel. The area stays
 * neutral; the only colour is the avatar's own, glowing behind its glass. The Git
 * Agent's own avatar sits in the middle and wakes as the drop gets close.
 */
export function DropZone({ seed, over }: { seed: string; over: boolean }): React.JSX.Element {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-9 bottom-0 z-20 flex bg-card/75 p-3 backdrop-blur-[3px] animate-in fade-in duration-150">
      <div
        className={cn(
          'flex flex-1 flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 text-center transition-all duration-200',
          over ? 'scale-[1.01] border-foreground/35 bg-muted/80 shadow-[0_0_0_6px] shadow-foreground/5' : 'border-foreground/20 bg-muted/45'
        )}
      >
        {/* Glass over the avatar's own colours: a blurred copy of the same painting glows behind a
            frosted disc, so the halo always matches whichever agent this is. */}
        <span className={cn('relative grid size-20 place-items-center transition-transform duration-200', over && 'scale-110')}>
          <AgentAvatar seed={seed} className={cn('absolute inset-0 size-full scale-125 opacity-90 blur-xl saturate-150 transition-all duration-300', over && 'scale-150 opacity-100')} />
          <span className="absolute inset-1.5 rounded-full border border-white/30 bg-white/15 shadow-[inset_0_1px_0_rgb(255_255_255/0.4),0_8px_24px_-8px_rgb(0_0_0/0.35)] backdrop-blur-md dark:border-white/15 dark:bg-white/8" />
          <AgentAvatar seed={seed} activity={over ? 'working' : 'thinking'} className="relative size-10" />
        </span>
        <span className="text-base font-bold tracking-tight text-foreground">{over ? 'Release to add' : 'Drop as context'}</span>
        <span className="max-w-60 text-xs font-medium text-muted-foreground">Files, folders and code join your next message to the Git Agent as chips.</span>
      </div>
    </div>
  )
}
