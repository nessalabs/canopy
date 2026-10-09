// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FileRefLinks, useLinkedMarkdown } from '../src/components/agent/answer-links'
import { MessageMarkdown } from '../src/components/ui/message-markdown'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Answer({ text }: { text: string }): React.JSX.Element {
  return <MessageMarkdown {...useLinkedMarkdown()}>{text}</MessageMarkdown>
}

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

const TEXT = 'The route is in `routes/agents.ts:22-26`, and the prompt in src/draft.ts:40.'

describe('FileRefLinks', () => {
  it('turns cited lines into links and hands a click to the host instead of navigating', () => {
    const onOpen = vi.fn(() => true)
    act(() => root.render(<FileRefLinks onOpen={onOpen}><Answer text={TEXT} /></FileRefLinks>))
    const links = [...host.querySelectorAll('a')]
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['routes/agents.ts:22-26', 'src/draft.ts:40'])
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    act(() => links[0]!.dispatchEvent(click))
    expect(onOpen).toHaveBeenCalledWith('routes/agents.ts:22-26')
    expect(click.defaultPrevented).toBe(true)
  })

  it('claims a diagram’s SVG link the same way', () => {
    const onOpen = vi.fn(() => true)
    act(() => root.render(<FileRefLinks onOpen={onOpen}><div id="svg-slot" /></FileRefLinks>))
    host.querySelector('#svg-slot')!.innerHTML = '<svg><a xlink:href="src/a.ts:3" xmlns:xlink="http://www.w3.org/1999/xlink"><text>Node</text></a></svg>'
    act(() => host.querySelector('text')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
    expect(onOpen).toHaveBeenCalledWith('src/a.ts:3')
  })

  it('links nothing where no host opens references', () => {
    act(() => root.render(<Answer text={TEXT} />))
    expect(host.querySelectorAll('a')).toHaveLength(0)
  })

  it('draws a change-map block and opens a part’s lines when its card is clicked', () => {
    const onOpen = vi.fn(() => true)
    const map = { title: 'Refunds', nodes: [{ id: 'svc', label: 'RefundService', path: 'services/refund.py', lines: '84-95', status: 'added' }, { id: 'pay', label: 'PaymentService', status: 'affected' }], edges: [{ from: 'svc', to: 'pay', label: 'refundable()' }] }
    act(() => root.render(<FileRefLinks onOpen={onOpen}><Answer text={'Here:\n\n```change-map\n' + JSON.stringify(map) + '\n```'} /></FileRefLinks>))
    expect(host.querySelector('[data-slot="change-map"] h3')?.textContent).toBe('Refunds')
    expect(host.querySelector('[data-slot="change-map"]')?.closest('pre')).toBeNull()
    expect(host.textContent).toContain('refundable()')
    const card = [...host.querySelectorAll('[data-slot="change-map"] button')].find((button) => button.textContent?.includes('RefundService'))!
    act(() => card.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onOpen).toHaveBeenCalledWith('services/refund.py:84-95')
    expect(card.getAttribute('aria-pressed')).toBe('true')
  })

  it('holds a placeholder while the block is still arriving', () => {
    act(() => root.render(<FileRefLinks onOpen={() => true}><Answer text={'```change-map\n{"nodes": [{"id"'} /></FileRefLinks>))
    expect(host.textContent).toContain('Drawing the change map')
  })
})

describe('drawn blocks', () => {
  const fence = (lang: string, spec: object) => `Here:\n\n\`\`\`${lang}\n${JSON.stringify(spec)}\n\`\`\`\n`
  const BLOCKS: Array<[string, object, string]> = [
    ['call-flow', { title: 'Refund call', participants: [{ id: 'r', label: 'Route', status: 'modified' }, { id: 's', label: 'RefundService', status: 'added', path: 'svc.ts', lines: 4 }], steps: [{ from: 'r', to: 's', label: 'issue()' }] }, 'RefundService'],
    ['blast-radius', { title: 'Reach', changed: [{ id: 's', label: 'RefundService', status: 'added', path: 'svc.ts', lines: '4' }] }, 'RefundService'],
    ['before-after', { title: 'Queue', rows: [{ id: 'q', before: { label: 'Dashboard' }, after: { label: 'RefundService', path: 'svc.ts', lines: '4' }, change: 'moved' }] }, 'RefundService'],
    ['data-model', { title: 'Tables', entities: [{ id: 'e', label: 'RefundService', status: 'added', path: 'svc.ts', lines: '4', fields: [{ name: 'id', type: 'uuid', key: 'primary' }] }] }, 'RefundService']
  ]

  it.each(BLOCKS)('draws a %s block, and a click on a part opens its code', (lang, spec, label) => {
    const onOpen = vi.fn(() => true)
    act(() => root.render(<FileRefLinks onOpen={onOpen}><Answer text={fence(lang, spec)} /></FileRefLinks>))
    expect(host.querySelector('pre')).toBeNull()
    const part = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes(label) || button.getAttribute('aria-label')?.includes(label))
    expect(part, `a button for ${label}`).toBeDefined()
    act(() => part!.click())
    expect(onOpen).toHaveBeenCalledWith('svc.ts:4')
  })

  it('holds the place of a block that has not finished arriving', () => {
    act(() => root.render(<FileRefLinks onOpen={() => true}><Answer text={'```data-model\n{"entities": [{"id": "e"'} /></FileRefLinks>))
    expect(host.textContent).toContain('Drawing the data model')
  })
})
