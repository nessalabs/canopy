import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { routes, type AgentStreamEvent } from '@canopy/shared'
import type { AgentEvent } from '@canopy/shared/agent-stream'

import { ClaudeAdapter, type SdkModule } from '../src/agents/claude'
import { createTestServer, type TestServer } from './helpers/test-server'

/**
 * A stand-in for the SDK: `run` plays the agent's side of the turn — including calling the
 * `canUseTool` the adapter handed it — while `captured` keeps the options it was launched with.
 */
function fakeSdk(run: (options: Options) => AsyncIterable<unknown>) {
  const captured: { options?: Options } = {}
  const module = {
    query: (args: { prompt: unknown; options: Options }) => {
      captured.options = args.options
      return run(args.options)
    }
  } as unknown as SdkModule
  return { module, captured }
}

const initMessage = (sessionId: string) => ({ type: 'system', subtype: 'init', session_id: sessionId, cwd: '/tmp/wt', tools: ['Bash'], model: 'claude-opus-5' })
const resultMessage = (sessionId: string, extra: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  session_id: sessionId,
  is_error: false,
  num_turns: 1,
  result: 'done',
  ...extra
})

const payloadOf = (frame: AgentStreamEvent): AgentEvent['payload'] | undefined => (frame.type === 'event' ? frame.event.payload : undefined)
const payloads = (frames: AgentStreamEvent[]) => frames.map(payloadOf).filter((payload): payload is AgentEvent['payload'] => payload !== undefined)
const shape = (frames: AgentStreamEvent[]) => frames.map((frame) => (frame.type === 'event' ? `event:${payloadOf(frame)?.type}` : frame.type))

async function drain(stream: AsyncIterable<AgentStreamEvent>): Promise<AgentStreamEvent[]> {
  const frames: AgentStreamEvent[] = []
  for await (const frame of stream) frames.push(frame)
  return frames
}

describe('claude adapter permission flow', () => {
  it('publishes the ask while the SDK is parked on it, then resumes on the answer', async () => {
    const decisions: unknown[] = []
    const { module } = fakeSdk((options) =>
      (async function* () {
        yield initMessage('sess-1')
        // The SDK blocks here: nothing else reaches the stream until the ask is answered, so a
        // loop that only waited on this iterator would never ship the prompt that unblocks it.
        decisions.push(await options.canUseTool?.('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 'tu1' } as never))
        yield resultMessage('sess-1')
      })()
    )

    const adapter = new ClaudeAdapter({ loadSdk: async () => module })
    const frames: AgentStreamEvent[] = []
    for await (const frame of adapter.send(null, 'run ls', { autonomy: 'edit' })) {
      frames.push(frame)
      if (payloadOf(frame)?.type === 'permission_requested') {
        expect(adapter.permissions.pending('sess-1')).toEqual(['tu1'])
        expect(adapter.answerPermission('sess-1', { requestId: 'tu1', behavior: 'allow' })).toBe(true)
      }
    }

    expect(payloads(frames)).toContainEqual(expect.objectContaining({ type: 'permission_requested', requestId: 'tu1', toolName: 'Bash', input: { command: 'ls' } }))
    expect(payloads(frames)).toContainEqual(expect.objectContaining({ type: 'permission_decided', requestId: 'tu1', decision: 'allow' }))

    const order = shape(frames)
    expect(order[0]).toBe('session')
    expect(order.indexOf('event:permission_requested')).toBeGreaterThan(-1)
    expect(order.indexOf('event:permission_requested')).toBeLessThan(order.indexOf('event:permission_decided'))
    expect(order.at(-1)).toBe('done')
    expect(frames.at(-1)).toEqual({ type: 'done', sessionId: 'sess-1' })
    // The SDK is told to run the call as proposed unless the answer rewrote its input.
    expect(decisions).toEqual([{ behavior: 'allow', updatedInput: { command: 'ls' } }])
    expect(adapter.permissions.pending('sess-1')).toEqual([])
  })

  it('denies a parked ask when the turn is aborted instead of hanging on it', async () => {
    const decisions: unknown[] = []
    const controller = new AbortController()
    const { module } = fakeSdk((options) =>
      (async function* () {
        yield initMessage('sess-2')
        decisions.push(await options.canUseTool?.('Bash', { command: 'rm -rf /' }, { signal: controller.signal, toolUseID: 'tu9' } as never))
        yield resultMessage('sess-2')
      })()
    )

    const adapter = new ClaudeAdapter({ loadSdk: async () => module })
    const frames: AgentStreamEvent[] = []
    for await (const frame of adapter.send('sess-2', 'clean up', { signal: controller.signal })) {
      frames.push(frame)
      if (payloadOf(frame)?.type === 'permission_requested') controller.abort()
    }

    expect(decisions).toEqual([{ behavior: 'deny', message: 'Canopy: the turn was cancelled before this Bash call was answered' }])
    expect(payloads(frames)).toContainEqual(expect.objectContaining({ type: 'permission_decided', decision: 'deny' }))
    expect(frames.at(-1)).toEqual({ type: 'done', sessionId: 'sess-2' })
    expect(adapter.permissions.pending('sess-2')).toEqual([])
  })

  it('carries a denial reason back to the model rather than a bare refusal', async () => {
    const decisions: unknown[] = []
    const { module } = fakeSdk((options) =>
      (async function* () {
        yield initMessage('sess-3')
        decisions.push(await options.canUseTool?.('WebFetch', { url: 'https://example.com' }, { signal: new AbortController().signal, toolUseID: 'tu3' } as never))
        yield resultMessage('sess-3')
      })()
    )
    const adapter = new ClaudeAdapter({ loadSdk: async () => module })
    for await (const frame of adapter.send('sess-3', 'fetch it', {})) {
      if (payloadOf(frame)?.type === 'permission_requested') adapter.answerPermission('sess-3', { requestId: 'tu3', behavior: 'deny' })
    }
    expect(decisions).toEqual([{ behavior: 'deny', message: 'Canopy: the user declined this WebFetch call' }])
  })

  it('opens the turn with the prompt the SDK never echoes back', async () => {
    const resumed = fakeSdk(() =>
      (async function* () {
        yield resultMessage('sess-e')
      })()
    )
    const frames = await drain(new ClaudeAdapter({ loadSdk: async () => resumed.module }).send('sess-e', 'ship it', { startSeq: 7 }))
    expect(shape(frames).slice(0, 2)).toEqual(['session', 'event:user_message'])
    expect(payloads(frames)[0]).toMatchObject({ type: 'user_message', text: 'ship it', synthetic: false })
    // The echo continues the transcript the client already holds rather than restarting it.
    expect(frames[1]).toMatchObject({ type: 'event', event: { seq: 7 } })
  })

  it('echoes an image turn too, with the images lifted out of the text', async () => {
    const fresh = fakeSdk(() =>
      (async function* () {
        yield initMessage('sess-f')
        yield resultMessage('sess-f')
      })()
    )
    const frames = await drain(
      new ClaudeAdapter({ loadSdk: async () => fresh.module }).send(null, 'look at [Image #1]', { images: [{ mediaType: 'image/png', data: 'AAA' }] })
    )
    // A new session cannot echo before `init` names it, so the envelope still comes first.
    expect(shape(frames).slice(0, 2)).toEqual(['session', 'event:user_message'])
    expect(payloads(frames)[0]).toMatchObject({ type: 'user_message', text: 'look at [Image #1]', synthetic: false })
  })

  it('relays what an unsuccessful result actually failed on', async () => {
    const { module } = fakeSdk(() =>
      (async function* () {
        yield resultMessage('sess-4', { subtype: 'error_during_execution', is_error: true, result: undefined, errors: ['tool timeout', 'no retries left'] })
      })()
    )
    const frames = await drain(new ClaudeAdapter({ loadSdk: async () => module }).send('sess-4', 'go'))
    expect(frames).toContainEqual({ type: 'error', message: 'claude: error_during_execution: tool timeout; no retries left' })
  })
})

describe('claude adapter autonomy', () => {
  const oneShot = () =>
    fakeSdk(() =>
      (async function* () {
        yield resultMessage('sess-a')
      })()
    )

  it('unlocks bypassPermissions only for full autonomy', async () => {
    const full = oneShot()
    await drain(new ClaudeAdapter({ loadSdk: async () => full.module }).send('sess-a', 'go', { autonomy: 'full' }))
    expect(full.captured.options?.permissionMode).toBe('bypassPermissions')
    // The SDK refuses the mode outright without this, so `full` would silently behave like `edit`.
    expect(full.captured.options?.allowDangerouslySkipPermissions).toBe(true)
    expect(full.captured.options?.canUseTool).toBeUndefined()
  })

  it('routes prompts through canUseTool for acceptEdits', async () => {
    const edit = oneShot()
    await drain(new ClaudeAdapter({ loadSdk: async () => edit.module }).send('sess-a', 'go', { autonomy: 'edit' }))
    expect(edit.captured.options?.permissionMode).toBe('acceptEdits')
    expect(typeof edit.captured.options?.canUseTool).toBe('function')
    expect(edit.captured.options?.allowDangerouslySkipPermissions).toBeUndefined()
  })
})

describe('permission route', () => {
  let server: TestServer
  beforeEach(async () => {
    server = await createTestServer()
  })
  afterEach(async () => {
    await server.close()
  })

  it('hands a decision to the adapter, and 404s one nobody is parked on', async () => {
    const answered = await server.call('POST', routes.permissions('claude', 's1'), { requestId: 'req-1', behavior: 'allow', updatedInput: { command: 'ls -a' } })
    expect(answered.status).toBe(204)
    expect(server.agent.answers).toEqual([{ requestId: 'req-1', behavior: 'allow', updatedInput: { command: 'ls -a' } }])

    const stale = await server.call('POST', routes.permissions('claude', 's1'), { requestId: 'gone', behavior: 'deny', message: 'too late' })
    expect(stale.status).toBe(404)
    expect(stale.body.error.code).toBe('unknown_permission_request')

    expect((await server.call('POST', routes.permissions('claude', 's1'), { behavior: 'allow' })).status).toBe(400)
  })
})
