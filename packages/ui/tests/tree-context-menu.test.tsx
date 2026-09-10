// @vitest-environment jsdom
import { act, useEffect, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ContextMenu, ContextMenuTrigger } from '../src/components/ui/context-menu'

/**
 * Stands in for TreeView, which keeps a ref on the same element it spreads the props it is
 * given onto — the shape that makes `asChild` dangerous, because the ref the trigger passes
 * down arrives as one of those props and lands after the component's own.
 */
function Scroller({ seen, ...props }: { seen: { element: HTMLDivElement | null } } & React.ComponentProps<'div'>): React.JSX.Element {
  const own = useRef<HTMLDivElement>(null)
  useEffect(() => {
    seen.element = own.current
  })
  return <div ref={own} data-slot="tree-view" {...props} />
}

describe('a tree inside a context menu trigger', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('loses its own ref when the trigger becomes it', () => {
    const seen = { element: null as HTMLDivElement | null }
    act(() =>
      root.render(
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <Scroller seen={seen} />
          </ContextMenuTrigger>
        </ContextMenu>
      )
    )
    // The failure this guards against: nothing to measure, so the tree windows to `overscan`
    // rows and leaves the rest of the panel blank.
    expect(seen.element).toBeNull()
  })

  it('keeps it when a plain element is the trigger instead', () => {
    const seen = { element: null as HTMLDivElement | null }
    act(() =>
      root.render(
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div>
              <Scroller seen={seen} />
            </div>
          </ContextMenuTrigger>
        </ContextMenu>
      )
    )
    expect(seen.element).not.toBeNull()
  })
})
