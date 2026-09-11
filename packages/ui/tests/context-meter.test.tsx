// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { TooltipProvider } from '../src/components/ui/tooltip'
import { ContextMeter, assumedContextWindow, describeContext, formatTokens } from '../src/components/agent/context-meter'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  localStorage.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})
const render = (node: React.ReactNode): void => act(() => root.render(<TooltipProvider>{node}</TooltipProvider>))
const meter = (): HTMLElement | null => host.querySelector('[data-slot=context-meter]')

describe('context meter', () => {
  it('formats tokens at the scale windows are compared at', () => {
    expect([842, 4200, 31437, 184000, 1_000_000, 1_500_000].map(formatTokens)).toEqual(['842', '4.2k', '31k', '184k', '1M', '1.5M'])
  })

  it('describes what it knows and no more', () => {
    expect(describeContext({ tokens: 31437, window: 1_000_000 }, 1_000_000)).toBe('31k of 1M context used · 3%')
    expect(describeContext({ tokens: 31437, window: null }, null)).toBe('31k tokens in context')
    expect(describeContext({ tokens: null, window: 200_000 }, 200_000)).toBe('Context window 200k')
  })

  it('is absent until the stream has said anything, then a meter with a level', () => {
    render(<ContextMeter usage={null} />)
    expect(meter()).toBeNull()
    render(<ContextMeter usage={{ tokens: 180_000, window: 200_000 }} model="claude-opus-5" />)
    expect(meter()?.dataset['level']).toBe('high')
    expect(meter()?.getAttribute('aria-valuenow')).toBe('90')
    expect(meter()?.textContent).toBe('90%')
  })

  it('remembers a model’s window across sessions that never stated it', () => {
    render(<ContextMeter usage={{ tokens: 10_000, window: 200_000 }} model="claude-haiku-4-5" />)
    expect(meter()?.textContent).toBe('5%')
    render(<ContextMeter usage={{ tokens: 100_000, window: null }} model="claude-haiku-4-5" />)
    expect(meter()?.textContent).toBe('50%')
    render(<ContextMeter usage={{ tokens: 100_000, window: null }} model="some-other-model" />)
    expect(meter()?.textContent).toBe('100k')
    expect(meter()?.getAttribute('aria-valuenow')).toBe('0')
  })

  it('assumes the family window when nothing has stated one, so a replayed session still has a fraction', () => {
    expect(assumedContextWindow('claude-fable-5-1')).toBe(1_000_000)
    expect(assumedContextWindow('claude-haiku-4-5-20251001')).toBe(200_000)
    expect(assumedContextWindow('claude-mystery[1m]')).toBe(1_000_000)
    expect(assumedContextWindow('gpt-5')).toBeNull()
    render(<ContextMeter usage={{ tokens: 583_000, window: null }} model="claude-fable-5-1" />)
    expect(meter()?.textContent).toBe('58%')
    expect(meter()?.dataset['level']).toBe('ok')
  })
})
