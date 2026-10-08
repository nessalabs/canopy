import { useRef, useState } from 'react'
import { FolderTree, PanelLeftClose, PanelLeftOpen, PanelTopClose, PanelTopOpen } from 'lucide-react'
import { Popover } from 'radix-ui'

import { IconAction } from '@/components/icon-action'
import { SplitView, SplitViewOrientation, SplitViewPanel, SplitViewSeparator } from '@/components/split-view'
import { Button } from '@/components/ui/button'
import { PopoverSurface } from '@/components/ui/popover-surface'
import { useElementWidth } from '@/lib/use-element-width'

/** Tree beside the content, tree above it, or tree in a popover — chosen from the container width. */
type Arrangement = 'side' | 'stacked' | 'overlay'

/** Below `overlayBelow` px the tree folds into a popover; a caller whose tree *is* the point can lower it. */
const arrangementFor = (width: number, overlayBelow: number): Arrangement => (width >= 680 ? 'side' : width >= overlayBelow ? 'stacked' : 'overlay')

// A wide container splits along a vertical line — tree left, file right. Squeeze it and the
// split turns horizontal, tree above the file, which is the only way a phone-width column
// gives either half a usable size.
const SPLIT: Record<Exclude<Arrangement, 'overlay'>, SplitViewOrientation> = {
  side: SplitViewOrientation.Horizontal,
  stacked: SplitViewOrientation.Vertical
}

/** The strip above the file when the tree is not on screen: one control, then the path. */
const CollapsedBar = ({ children, header }: { children: React.ReactNode; header?: React.ReactNode }): React.JSX.Element => (
  <div className="flex shrink-0 items-center gap-1 border-b border-border bg-muted/30 px-2 py-1">
    {children}
    {header}
  </div>
)

/** A pick is the one click that has got what it came for; a folder or a checkbox has not. */
const isFilePick = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null
  return Boolean(element?.closest('[data-slot="tree-view-row"][data-kind="file"]') && !element.closest('[data-checkbox]'))
}

/** Narrow containers: the tree opens from a button and closes on a tap outside or a pick. */
function TreePopover({ tree, footer, label, header }: { tree: React.ReactNode; footer?: React.ReactNode; label: string; header?: React.ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <CollapsedBar header={header}>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <Button variant="ghost" size="icon" className="size-7" aria-label={label} aria-expanded={open}>
            <FolderTree className="size-4" />
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content asChild side="bottom" align="start" sideOffset={6} collisionPadding={8} onClick={(event) => isFilePick(event.target) && setOpen(false)}>
            <PopoverSurface className="z-50 flex h-[60vh] w-[min(92vw,24rem)] flex-col overflow-hidden p-0">
              <div className="min-h-0 flex-1">{tree}</div>
              {footer}
            </PopoverSurface>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </CollapsedBar>
  )
}

/**
 * The frame both file explorers share: a tree and the content it picks, arranged for the room
 * the container actually has rather than for the window. Wide, they sit side by side; medium,
 * stacked; narrow, the tree moves behind a button so the file keeps the whole column. Hiding
 * the tree by hand does the same thing at any width, which is how a stacked explorer gives
 * the file every pixel of height back.
 */
export function ExplorerShell({
  tree,
  treeLabel,
  overlayHeader,
  sideTreeSize = 30,
  stackedTreeSize = 40,
  treeMeta,
  treeFooter,
  content,
  overlayBelow = 480,
  className
}: {
  tree: React.ReactNode
  /** Names the tree for the popover trigger the narrow arrangement uses. */
  treeLabel: string
  /** Shown beside that trigger — usually the path of the file on screen. */
  overlayHeader?: React.ReactNode
  /** Share of the width the tree takes beside the content, and of the height above it. */
  sideTreeSize?: number
  stackedTreeSize?: number
  /** Beside the tree's label — what it lists, in numbers. */
  treeMeta?: React.ReactNode
  /**
   * Pinned under the tree — the commit box. It sits inside the panel rather than under the whole
   * explorer so that it scrolls with nothing, survives the tree going empty, and does not change
   * the explorer's own height, which callers compute by hand.
   */
  treeFooter?: React.ReactNode
  content: React.ReactNode
  /** The width under which the tree moves behind a button; 0 keeps it on screen at any width. */
  overlayBelow?: number
  className?: string
}): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null)
  const [hidden, setHidden] = useState(false)
  const measured = arrangementFor(useElementWidth(container), overlayBelow)
  const arrangement = hidden ? 'overlay' : measured
  // Wide, the tree sits to the side and folds away to the left; stacked, it sits above and
  // folds up — the icon says which way the panel goes.
  const [Close, Open] = measured === 'side' ? [PanelLeftClose, PanelLeftOpen] : [PanelTopClose, PanelTopOpen]

  return (
    <div ref={container} className={className}>
      {arrangement === 'overlay' ? (
        <div className="flex h-full min-h-0 flex-col">
          {/* A tree the reader hid comes back where it was, from the one button that put it
              away; one the width folded away has nowhere wider to go, so it opens as a popover. */}
          {hidden ? (
            <CollapsedBar header={overlayHeader}>
              <IconAction label="Show the file tree" onClick={() => setHidden(false)}>
                <Open aria-hidden className="size-3.5" />
              </IconAction>
            </CollapsedBar>
          ) : (
            <TreePopover tree={tree} footer={treeFooter} label={treeLabel} header={overlayHeader} />
          )}
          <div className="min-h-0 flex-1">{content}</div>
          {/* The hidden tree keeps its footer under the file; the popover carries its own. */}
          {hidden ? treeFooter : null}
        </div>
      ) : (
        <SplitView orientation={SPLIT[arrangement]} className="h-full">
          <SplitViewPanel
            id="files"
            defaultSize={arrangement === 'side' ? sideTreeSize : stackedTreeSize}
            minSize={15}
            className={arrangement === 'side' ? 'min-h-0 border-r border-border bg-card' : 'min-h-0 border-b border-border bg-card'}
          >
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border pe-1 ps-3">
                <span className="truncate text-xs text-muted-foreground">{treeLabel}</span>
                <span className="ms-auto flex shrink-0 items-center gap-2">{treeMeta}</span>
                <IconAction label="Hide the file tree" onClick={() => setHidden(true)}>
                  <Close aria-hidden className="size-3.5" />
                </IconAction>
              </div>
              <div className="min-h-0 flex-1">{tree}</div>
              {treeFooter}
            </div>
          </SplitViewPanel>
          <SplitViewSeparator />
          <SplitViewPanel id="content" minSize={20} className="min-h-0">
            {content}
          </SplitViewPanel>
        </SplitView>
      )}
    </div>
  )
}
