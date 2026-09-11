// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AgentAvatar } from '../src/components/agent/agent-avatar'
import { TurnStatus } from '../src/components/agent/turn-status'

/** The pieces of a browser jsdom lacks and the nessa components reach for. */
function stubBrowser(): void {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
  class Observer {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  window.IntersectionObserver = Observer as unknown as typeof IntersectionObserver
  Element.prototype.animate = (() => ({ cancel: () => undefined, play: () => undefined, pause: () => undefined, finished: Promise.resolve(), onfinish: null })) as unknown as typeof Element.prototype.animate
}

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  stubBrowser()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const render = (node: React.ReactNode): void => act(() => root.render(node))
const avatar = (): HTMLElement => host.querySelector('[data-slot=random-avatar]') as HTMLElement

describe('AgentAvatar', () => {
  it("is nessa's painting at rest when the agent is idle", () => {
    render(<AgentAvatar seed="s" name="Agent" />)
    expect(avatar().dataset['activity']).toBeUndefined()
    expect(avatar().hasAttribute('aria-busy')).toBe(false)
    expect(host.querySelector('[aria-label="Agent"]')).not.toBeNull()
  })

  it("puts the painting into nessa's working state and says what the agent is doing", () => {
    render(<AgentAvatar seed="s" name="Agent" activity="working" />)
    expect(avatar().dataset['activity']).toBe('working')
    expect(avatar().getAttribute('aria-busy')).toBe('true')
    expect(host.querySelector('[aria-label="Agent, working"]')).not.toBeNull()
  })

  it('is the one painting, not a stack of copies', () => {
    render(<AgentAvatar seed="s" activity="solving" />)
    expect(host.querySelectorAll('svg')).toHaveLength(1)
  })
})

describe('TurnStatus', () => {
  it('is a running cue: small working avatar, shimmering verb, elapsed beside it', () => {
    render(<TurnStatus activity="thinking" startedAt={Date.now() - 9000} tokens={242} avatarSeed="session-1" />)
    const cue = host.querySelector('[data-slot=agent-activity-cue]') as HTMLElement
    expect(cue.dataset['status']).toBe('running')
    expect(avatar().dataset['activity']).toBe('thinking')
    expect(avatar().getAttribute('aria-busy')).toBe('true')
    // Nine seconds in, the verb has already rotated once.
    expect(host.textContent).toContain('Pondering…')
    expect(host.textContent).toContain('9s · 242 tokens')
  })
})
