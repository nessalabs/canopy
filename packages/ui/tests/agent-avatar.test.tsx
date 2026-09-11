// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ACTIVITY_MOTIONS, AVATAR_MOTIONS, AgentAvatar } from '../src/components/agent/agent-avatar'
import { TurnStatus } from '../src/components/agent/turn-status'
import { AvatarLab } from '../src/lab/avatar-lab'

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
const avatar = (): HTMLElement => host.querySelector('[data-slot=agent-avatar]') as HTMLElement
const paintings = (): number => host.querySelectorAll('[data-slot=random-avatar]').length

describe('AgentAvatar', () => {
  it('is exactly one resting painting when the agent is idle', () => {
    render(<AgentAvatar seed="s" name="Agent" />)
    expect(avatar().dataset['activity']).toBeUndefined()
    expect(avatar().dataset['motions']).toBeUndefined()
    expect(paintings()).toBe(1)
    expect(host.querySelector('[aria-label="Agent"]')).not.toBeNull()
  })

  it('plays the activity preset and says what the agent is doing', () => {
    render(<AgentAvatar seed="s" name="Agent" activity="working" />)
    expect(avatar().dataset['activity']).toBe('working')
    expect(avatar().dataset['motions']).toBe(ACTIVITY_MOTIONS.working.join(' '))
    // The tide runs inside the painting itself; the halo is a second copy of the paint.
    expect(host.querySelector('[data-slot=random-avatar][aria-busy]')).not.toBeNull()
    expect(host.querySelector('.agent-avatar-halo')).not.toBeNull()
    expect(host.querySelector('[aria-label="Agent, working"]')).not.toBeNull()
  })

  it('keeps every decorative copy out of the accessibility tree', () => {
    render(<AgentAvatar seed="s" name="Agent" motions={AVATAR_MOTIONS.map((entry) => entry.motion)} />)
    const labelled = host.querySelectorAll('[data-slot=random-avatar] svg[role=img]')
    expect(labelled).toHaveLength(1)
    expect(paintings()).toBeGreaterThan(1)
  })

  it('explicit motions override the activity preset', () => {
    render(<AgentAvatar seed="s" activity="thinking" motions={['spin']} />)
    expect(avatar().dataset['motions']).toBe('spin')
    expect(host.querySelector('.agent-avatar-spin')).not.toBeNull()
    expect(host.querySelector('.agent-avatar-glow')).toBeNull()
  })
})

describe('TurnStatus', () => {
  it("shows the agent's own avatar in the avatar column, moving", () => {
    render(<TurnStatus activity="thinking" startedAt={Date.now()} tokens={0} avatarSeed="session-1" />)
    expect(avatar().dataset['activity']).toBe('thinking')
    expect(host.textContent).toContain('Thinking…')
  })
})

describe('AvatarLab', () => {
  it('renders every motion and every preset without a daemon', () => {
    render(<AvatarLab />)
    for (const { label } of AVATAR_MOTIONS) expect(host.textContent).toContain(label)
    expect(host.querySelectorAll('[data-slot=agent-avatar]').length).toBeGreaterThan(AVATAR_MOTIONS.length)
  })
})
