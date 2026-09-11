// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentEvent, AgentEventPayload, ToolKind } from '@canopy/shared/agent-stream'
import { applyDeltas, buildTranscript } from '@canopy/shared/agent-stream'

// Markdown pulls mermaid and shiki, which have no business in a layout test.
vi.mock('@/components/ui/message-markdown', () => ({
  MessageMarkdown: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>
}))

import { TranscriptView } from '../src/components/agent/transcript'

let seq = 0
const ev = (payload: AgentEventPayload): AgentEvent => {
  const s = seq++
  return { id: `s:${s}`, sessionId: 's', seq: s, ts: null, agentPath: [], payload, raw: null }
}
const prompt = (text: string) => ev({ type: 'user_message', text, synthetic: false })
const said = (text: string) => ev({ type: 'assistant_text', text, block: null })
const call = (callId: string, name: string, kind: ToolKind, title: string) => ev({ type: 'tool_call_started', callId, name, kind, input: { title }, title })
const done = (callId: string) => ev({ type: 'tool_call_completed', callId, result: { text: `output of ${callId}`, isError: false, structured: null, images: [] } })
const result = (finalText: string | null) =>
  ev({ type: 'turn_completed', status: 'completed', stopReason: null, terminalReason: null, finalText, usage: null, durationMs: null, numTurns: null, permissionDenials: [] })

/** The pieces of a browser jsdom lacks and the nessa components reach for. */
function stubBrowser(): void {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
  class Observer {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  window.ResizeObserver = Observer as unknown as typeof ResizeObserver
  window.IntersectionObserver = Observer as unknown as typeof IntersectionObserver
  Element.prototype.animate = (() => ({ cancel: () => undefined, finished: Promise.resolve(), onfinish: null })) as unknown as typeof Element.prototype.animate
  Element.prototype.scrollIntoView = () => undefined
  Element.prototype.scrollTo = () => undefined
  // jsdom lays nothing out, so a Range has no box; the selection popover asks every one for its.
  Range.prototype.getBoundingClientRect = (() => new DOMRect(10, 200, 80, 16)) as unknown as typeof Range.prototype.getBoundingClientRect
}

/** Selects a text node end to end, the way dragging across it would. */
function select(node: Node): void {
  const range = document.createRange()
  range.selectNodeContents(node)
  const selection = document.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

describe('TranscriptView', () => {
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

  const render = (events: AgentEvent[], extra: Partial<React.ComponentProps<typeof TranscriptView>> = {}): void => {
    const transcript = buildTranscript(events, { live: extra.startedAt !== undefined && extra.startedAt !== null })
    act(() => {
      root.render(
        <TranscriptView
          transcript={transcript}
          previews={applyDeltas(events)}
          extras={{}}
          pending={null}
          streamingText=""
          activity={null}
          startedAt={null}
          tokens={0}
          avatarSeed="seed"
          emptyMessage="empty"
          filesByTurn={new Map()}
          onReviewTurn={() => undefined}
          {...extra}
        />
      )
    })
  }

  it('shows the work as one cue, keeps the tool calls out of the transcript, and opens them in a sheet', () => {
    render([
      prompt('look'),
      said('Let me look.'),
      call('c1', 'Read', 'file_read', 'src/a.ts'),
      done('c1'),
      call('c2', 'Grep', 'search', 'needle'),
      done('c2'),
      call('c3', 'Bash', 'shell', 'npm test'),
      done('c3'),
      said('Found it.'),
      result('Found it.')
    ])
    const text = host.textContent ?? ''
    expect(text).toContain('Explored 1 file, 1 search, 1 command')
    // The last thing the agent said used to vanish (the fold lifts it out of the turn).
    expect(text).toContain('Found it.')
    expect(text).not.toContain('src/a.ts')
    expect(text).not.toContain('npm test')

    const cue = host.querySelector<HTMLButtonElement>('[data-slot="agent-activity-trigger"]')
    expect(cue).not.toBeNull()
    act(() => cue?.click())
    const sheet = document.querySelector('[role="dialog"]')
    expect(sheet?.textContent).toContain('src/a.ts')
    expect(sheet?.textContent).toContain('npm test')
    expect(cue?.getAttribute('aria-expanded')).toBe('true')
  })

  it('never draws harness bookkeeping as something the user said', () => {
    render([
      prompt('<task-notification>\n<task-id>abc</task-id>\n<status>stopped</status>\n</task-notification>'),
      said('Noted.'),
      result('Noted.')
    ])
    expect(host.textContent).not.toContain('task-notification')
    expect(host.textContent).toContain('Noted.')
  })

  it('offers to copy what was said, on the prompt and the answer alike', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render([prompt('look'), said('Found it.'), result('Found it.')])
    const copies = [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Copy this message"]')]
    expect(copies).toHaveLength(2)
    act(() => copies[1]?.click())
    expect(writeText).toHaveBeenCalledWith('Found it.')
    await act(async () => undefined)
    expect(copies[1]?.getAttribute('aria-label')).toBe('Copied')
  })

  it('offers the selected text to the composer, and only for a selection inside the conversation', () => {
    const onQuote = vi.fn()
    render([prompt('look'), said('Found it.'), result('Found it.')], { onQuote })
    const pill = '[data-slot="selection-actions"]'
    expect(document.querySelector(pill)).toBeNull()

    const outside = document.createElement('p')
    outside.textContent = 'not the conversation'
    document.body.appendChild(outside)
    act(() => {
      select(outside.firstChild!)
      document.dispatchEvent(new Event('pointerup', { bubbles: true }))
    })
    expect(document.querySelector(pill)).toBeNull()
    outside.remove()

    const answer = [...host.querySelectorAll('[data-testid="markdown"]')].at(-1)
    act(() => {
      select(answer!.firstChild!)
      document.dispatchEvent(new Event('pointerup', { bubbles: true }))
    })
    const ask = document.querySelector<HTMLButtonElement>(`${pill} [aria-label="Ask the agent about the selected text"]`)
    expect(ask).not.toBeNull()
    act(() => ask?.click())
    expect(onQuote).toHaveBeenCalledWith('Found it.')
    // Acting on the selection puts the pill away.
    expect(document.querySelector(pill)).toBeNull()
  })

  it('asks the user about a tool the agent may not run, and reports the answer', () => {
    const onAnswerPermission = vi.fn()
    render(
      [
        prompt('deploy'),
        ev({ type: 'permission_requested', requestId: 'req-1', callId: 'c9', toolName: 'Bash', input: { command: 'rm -rf dist' }, reason: 'mode', displayName: null, description: 'Clean the build output' })
      ],
      { startedAt: Date.now(), activity: 'working', onAnswerPermission }
    )
    expect(host.textContent).toContain('Clean the build output')
    expect(host.textContent).toContain('rm -rf dist')
    const allow = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Allow')
    expect(allow).toBeDefined()
    act(() => allow?.click())
    expect(onAnswerPermission).toHaveBeenCalledWith({ requestId: 'req-1', behavior: 'allow' })
  })
})
