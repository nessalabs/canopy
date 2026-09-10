// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ErrorBoundary } from '../src/components/error-boundary'

function Boom({ fail }: { fail: boolean }): React.JSX.Element {
  if (fail) throw new Error('forkedFromDatabase is undefined')
  return <p>panel content</p>
}

describe('ErrorBoundary', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    // React reports every caught render error on console.error; the fallback is what we assert on.
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.restoreAllMocks()
  })

  const render = (node: React.ReactNode): void => {
    act(() => root.render(node))
  }

  it('keeps the rest of the screen alive when a region throws', () => {
    render(
      <div>
        <p>sidebar</p>
        <ErrorBoundary label="Databases">
          <Boom fail />
        </ErrorBoundary>
      </div>
    )

    expect(host.textContent).toContain('sidebar')
    expect(host.textContent).toContain('Databases failed to render')
    expect(host.textContent).toContain('forkedFromDatabase is undefined')
  })

  it('renders its children untouched while they hold', () => {
    render(
      <ErrorBoundary label="Databases">
        <Boom fail={false} />
      </ErrorBoundary>
    )
    expect(host.textContent).toBe('panel content')
  })

  it('clears the error when the reset key changes', () => {
    render(
      <ErrorBoundary label="This screen" resetKey="/worktrees/a">
        <Boom fail />
      </ErrorBoundary>
    )
    expect(host.textContent).toContain('failed to render')

    render(
      <ErrorBoundary label="This screen" resetKey="/worktrees/b">
        <Boom fail={false} />
      </ErrorBoundary>
    )
    expect(host.textContent).toBe('panel content')
  })

  it('retries in place when asked', () => {
    render(
      <ErrorBoundary label="Databases">
        <Boom fail />
      </ErrorBoundary>
    )
    const retry = host.querySelector('button')
    expect(retry?.textContent).toContain('Try again')

    // The child stops throwing before the retry, the way a refetch or an event would fix it.
    render(
      <ErrorBoundary label="Databases">
        <Boom fail={false} />
      </ErrorBoundary>
    )
    act(() => retry?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(host.textContent).toBe('panel content')
  })
})
