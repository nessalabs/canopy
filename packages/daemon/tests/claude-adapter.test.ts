import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { routes, type AgentStreamEvent } from '@canopy/shared'
import type { AgentEvent } from '@canopy/shared/agent-stream'

import { ClaudeAdapter, type SdkModule } from '../src/agents/claude'
import type { RewindFilesResult } from '../src/agents/claude-live'
import { createFixtureRepo, type FixtureRepo } from './helpers/fixture-repo'
import { createTestServer, type TestServer } from './helpers/test-server'

/** What the fake CLI answers the capability probe with, when a test asks for one. */
interface ProbeFixtures {
  init?: Record<string, unknown>
  models?: unknown[]
  agents?: unknown[]
  mcp?: unknown[]
  settings?: unknown | (() => unknown)
  /** What `query.rewindFiles` answers; absent means the CLI does not offer the call at all. */
  rewind?: (userMessageId: string, options?: { dryRun?: boolean }) => RewindFilesResult | Promise<RewindFilesResult>
}

/**
 * A stand-in for the SDK.
 *
 * `run` plays the agent's side of the turn — including calling the `canUseTool` the adapter handed
 * it, and reading the prompt stream the adapter feeds. What it returns is dressed up as the SDK's
 * `Query`: an async iterable that also answers the control channel (interrupt, setModel,
 * setPermissionMode) and the capability probe, so one fake covers both halves of the adapter.
 */
function fakeSdk(run: (options: Options, prompt: AsyncIterable<SDKUserMessage>) => AsyncIterable<unknown>, fixtures: ProbeFixtures = {}) {
  const captured: {
    options?: Options
    /** Every control request the adapter made, in order. */
    interrupts: number
    models: Array<string | undefined>
    modes: string[]
    /** How many times a probe actually started a CLI — the cache's whole point. */
    probes: number
    /** Every `query()` the adapter made: a rewind that starts its own CLI shows up here. */
    queries: Array<Options>
    rewinds: Array<{ messageId: string; dryRun?: boolean }>
  } = { interrupts: 0, models: [], modes: [], probes: 0, queries: [], rewinds: [] }

  const module = {
    query: (args: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      captured.options = args.options
      captured.queries.push(args.options)
      return Object.assign(run(args.options, args.prompt), {
        interrupt: async () => void captured.interrupts++,
        setModel: async (model?: string) => void captured.models.push(model),
        setPermissionMode: async (mode: string) => void captured.modes.push(mode),
        ...(fixtures.rewind
          ? {
              rewindFiles: async (messageId: string, options?: { dryRun?: boolean }) => {
                captured.rewinds.push({ messageId, dryRun: options?.dryRun })
                return fixtures.rewind?.(messageId, options)
              }
            }
          : {}),
        initializationResult: async () => {
          captured.probes++
          return { commands: [], agents: [], models: [], output_style: 'default', available_output_styles: ['default'], account: {}, ...fixtures.init }
        },
        supportedModels: async () => fixtures.models ?? [],
        supportedAgents: async () => fixtures.agents ?? [],
        mcpServerStatus: async () => fixtures.mcp ?? [],
        return: async () => undefined
      })
    },
    resolveSettings: async () => {
      const settings = typeof fixtures.settings === 'function' ? (fixtures.settings as () => unknown)() : fixtures.settings
      return settings ?? { effective: {}, provenance: {}, sources: [] }
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

describe('claude adapter live controls', () => {
  it('folds a prompt queued mid-turn into the turn the agent is still reading', async () => {
    const read: Array<unknown> = []
    const fake = fakeSdk((_options, prompt) =>
      (async function* () {
        const prompts = prompt[Symbol.asyncIterator]()
        read.push((await prompts.next()).value)
        yield initMessage('sess-q')
        // Parks on the prompt stream the way the CLI does between tool rounds: nothing else
        // reaches the turn until someone types.
        read.push((await prompts.next()).value)
        yield resultMessage('sess-q')
      })()
    )

    const adapter = new ClaudeAdapter({ loadSdk: async () => fake.module })
    const frames: AgentStreamEvent[] = []
    for await (const frame of adapter.send(null, 'first', {})) {
      frames.push(frame)
      // A fresh session is only addressable once `init` has named it — which is exactly when the
      // client learns the id, from this frame.
      if (frame.type === 'session') expect(adapter.queue('sess-q', 'and also this')).toBe(true)
    }

    expect(read.map((message) => (message as SDKUserMessage | undefined)?.message.content)).toEqual(['first', 'and also this'])
    // The SDK never echoes a prompt back, so the queued one is put into the stream here or the
    // live transcript disagrees with the replay of the same turn.
    expect(payloads(frames)).toContainEqual(expect.objectContaining({ type: 'user_message', text: 'and also this' }))
    expect(adapter.queue('sess-q', 'too late')).toBe(false)
  })

  it('interrupts and retunes only while the turn is running', async () => {
    const fake = fakeSdk(() =>
      (async function* () {
        yield initMessage('sess-i')
        yield resultMessage('sess-i')
      })()
    )
    const adapter = new ClaudeAdapter({ loadSdk: async () => fake.module })
    expect(await adapter.interrupt('sess-i')).toBe(false)

    for await (const frame of adapter.send('sess-i', 'go')) {
      if (payloadOf(frame)?.type !== 'user_message') continue
      expect(await adapter.interrupt('sess-i')).toBe(true)
      expect(await adapter.control('sess-i', { model: 'opus', autonomy: 'read-only' })).toBe(true)
    }

    expect(fake.captured.interrupts).toBe(1)
    expect(fake.captured.models).toEqual(['opus'])
    expect(fake.captured.modes).toEqual(['plan'])
    // The turn is over: its handle is gone, and a stale client learns so from the 404 this drives.
    expect(await adapter.interrupt('sess-i')).toBe(false)
    expect(await adapter.control('sess-i', { model: 'opus' })).toBe(false)
  })

  it('reports what the turn cost, ahead of done', async () => {
    const fake = fakeSdk(() =>
      (async function* () {
        yield resultMessage('sess-u', {
          total_cost_usd: 0.42,
          duration_ms: 8100,
          usage: { input_tokens: 12, output_tokens: 340, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 1_200 },
          // Several models run through one turn; the window belongs to the one doing the work.
          modelUsage: { 'claude-opus-5': { inputTokens: 12, contextWindow: 1_000_000 }, 'claude-haiku-4-5': { inputTokens: 3, contextWindow: 200_000 } }
        })
      })()
    )
    const frames = await drain(new ClaudeAdapter({ loadSdk: async () => fake.module }).send('sess-u', 'go'))
    expect(shape(frames).at(-2)).toBe('usage')
    expect(frames.at(-2)).toEqual({
      type: 'usage',
      costUsd: 0.42,
      inputTokens: 12,
      outputTokens: 340,
      contextTokens: 91_212,
      contextWindow: 1_000_000,
      durationMs: 8100
    })
  })

  it('leaves cost out entirely when the CLI priced nothing', async () => {
    const fake = fakeSdk(() =>
      (async function* () {
        yield resultMessage('sess-s', { total_cost_usd: 0, duration_ms: 10, usage: { input_tokens: 5, output_tokens: 6 } })
      })()
    )
    const frames = await drain(new ClaudeAdapter({ loadSdk: async () => fake.module }).send('sess-s', 'go'))
    // A subscription session reports no price; zero would read as free rather than as unknown.
    expect(frames.at(-2)).toEqual({ type: 'usage', inputTokens: 5, outputTokens: 6, contextTokens: 5, durationMs: 10 })
  })

  it('renders a local slash command as assistant text and swallows the bookkeeping lines', async () => {
    const fake = fakeSdk(() =>
      (async function* () {
        yield initMessage('sess-l')
        yield { type: 'system', subtype: 'local_command_output', content: 'Context: 42k/1M tokens', uuid: 'u-local', session_id: 'sess-l' }
        yield { type: 'system', subtype: 'commands_changed', commands: [{ name: 'fresh', description: 'new', argumentHint: '' }], uuid: 'u-cc', session_id: 'sess-l' }
        yield { type: 'conversation_reset', new_conversation_id: 'c2', uuid: 'u-cr', session_id: 'sess-l' }
        yield resultMessage('sess-l')
      })()
    )
    const frames = await drain(new ClaudeAdapter({ loadSdk: async () => fake.module }).send('sess-l', '/context'))
    expect(payloads(frames)).toContainEqual(expect.objectContaining({ type: 'assistant_text', text: 'Context: 42k/1M tokens' }))
    // `commands_changed` feeds the capability cache and `conversation_reset` is the UI's own job;
    // neither belongs in the transcript as an `unknown` event.
    expect(shape(frames).filter((type) => type.startsWith('event:unknown'))).toEqual([])
  })

  it('reports no token figures for a turn that made no model call', async () => {
    const fake = fakeSdk(() =>
      (async function* () {
        yield initMessage('sess-z')
        yield resultMessage('sess-z', { total_cost_usd: 0, duration_ms: 400, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
      })()
    )
    const frames = await drain(new ClaudeAdapter({ loadSdk: async () => fake.module }).send('sess-z', '/context'))
    // "0 context" would say the window was empty; a local command simply reports nothing.
    expect(frames.at(-2)).toEqual({ type: 'usage', durationMs: 400 })
  })

  it('replays a stored slash command as the prompt and the answer the person saw', async () => {
    // The answer lives only in the session file (the SDK drops system rows), so the fixture writes one.
    const home = mkdtempSync(join(tmpdir(), 'canopy-claude-'))
    const previousHome = process.env.HOME
    process.env.HOME = home
    try {
      const cwd = '/tmp/wt-replay'
      const dir = join(home, '.claude', 'projects', '-tmp-wt-replay')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'sess-r.jsonl'),
        [
          { type: 'system', subtype: 'local_command', uuid: 'u0', parentUuid: null, content: '/compact' },
          { type: 'user', uuid: 'u2', parentUuid: 'u0', message: { role: 'user', content: '<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args>keep the test plan</command-args>' } },
          { type: 'system', subtype: 'local_command', uuid: 'u3', parentUuid: 'u2', content: '<local-command-stdout>Compacted 84k → 12k</local-command-stdout>' }
        ]
          .map((row) => JSON.stringify(row))
          .join('\n')
      )
      const fake = {
        ...fakeSdk(() => (async function* () {})()).module,
        getSessionMessages: async () => [
          { type: 'user', uuid: 'u1', session_id: 'sess-r', message: { role: 'user', content: '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>' } },
          { type: 'user', uuid: 'u2', session_id: 'sess-r', message: { role: 'user', content: '<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args>keep the test plan</command-args>' } }
        ]
      } as unknown as SdkModule
      const { events } = await new ClaudeAdapter({ loadSdk: async () => fake }).transcript('sess-r', cwd)
      const kinds = events.map((event) => event.payload)
      expect(kinds).toContainEqual(expect.objectContaining({ type: 'user_message', text: '/compact keep the test plan', synthetic: false }))
      expect(kinds).toContainEqual(expect.objectContaining({ type: 'assistant_text', text: 'Compacted 84k → 12k' }))
      // The caveat and the bare command echo are bookkeeping: no bubble for either.
      expect(kinds.filter((payload) => payload.type === 'user_message' && !('synthetic' in payload && payload.synthetic))).toHaveLength(1)
      expect(kinds.filter((payload) => payload.type === 'assistant_text')).toHaveLength(1)
      // The answer follows its prompt, as it did on screen.
      expect(kinds.findIndex((payload) => payload.type === 'assistant_text')).toBeGreaterThan(kinds.findIndex((payload) => payload.type === 'user_message' && !payload.synthetic))
    } finally {
      process.env.HOME = previousHome
      rmSync(home, { recursive: true, force: true })
    }
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

describe('claude capabilities', () => {
  const cwd = '/tmp/wt'
  const commands = [
    { name: 'compact', description: 'Clear the conversation history', argumentHint: '' },
    { name: 'exit', description: 'Exit the REPL', argumentHint: '' },
    { name: 'ship', description: 'Group commits, push and open a PR (user)', argumentHint: 'optional title' },
    { name: 'dataviz', description: 'Chart design guidance (user)', argumentHint: '' },
    { name: 'frontend-design:frontend-design', description: '(frontend-design) Distinctive visual design', argumentHint: '', aliases: ['frontend-design'] }
  ]
  const models = [
    { value: 'default', displayName: 'Default (recommended)', description: 'Opus 5 with 1M context', resolvedModel: 'claude-opus-5[1m]', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'haiku', displayName: 'Haiku 4.5', description: 'Fastest' }
  ]
  const agents = [{ name: 'Explore', description: 'Read-only search agent', model: 'sonnet' }]
  const mcp = [{ name: 'playwright', status: 'connected' }]
  const settings = {
    effective: {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'state.sh' }] }],
        PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'lint.sh' }, { type: 'http', url: 'https://audit.example' }] }]
      }
    },
    provenance: { hooks: { source: 'user' } },
    sources: [
      { source: 'user', settings: { hooks: { SessionStart: [] } } },
      { source: 'project', settings: { hooks: { PreToolUse: [] } } }
    ]
  }

  /** What a turn advertises about itself — the half no probe can see. */
  const advertisement = {
    ...initMessage('sess-cap'),
    skills: ['dataviz'],
    terminal_slash_commands: ['exit'],
    tools: ['Bash', 'Read'],
    plugins: [{ name: 'frontend-design', version: '1.2.0', path: '/plugins/fd' }],
    mcp_servers: [{ name: 'playwright', status: 'pending' }],
    claude_code_version: '2.0.99',
    permissionMode: 'acceptEdits',
    output_style: 'Concise'
  }

  const adapterWith = (extra: Record<string, unknown> = {}) => {
    const fake = fakeSdk(
      () =>
        (async function* () {
          yield advertisement
          yield resultMessage('sess-cap')
        })(),
      { init: { commands, account: { email: 'dev@example.com', organization: 'Example', subscriptionType: 'Claude Max' }, available_output_styles: ['default', 'Concise'] }, models, agents, mcp, settings, ...extra }
    )
    return { fake, adapter: new ClaudeAdapter({ loadSdk: async () => fake.module }) }
  }

  it('answers from the probe alone before any turn has run in the checkout', async () => {
    const { fake, adapter } = adapterWith()
    const cold = await adapter.capabilities(cwd)

    expect(fake.captured.probes).toBe(1)
    // The probe never sees a `system/init`, so everything only init carries is simply not known
    // yet — the answer still succeeds rather than waiting for a turn that may never come.
    expect(cold).toMatchObject({ provider: 'claude', cwd, tools: [], skills: [], plugins: [], version: undefined })
    expect(cold.outputStyles).toEqual(['default', 'Concise'])
    expect(cold.account).toEqual({ email: 'dev@example.com', organization: 'Example', subscriptionType: 'Claude Max' })
    // Without a turn's skill and terminal lists, those two can only be read as what they look like.
    expect(cold.commands.map((command) => command.source)).toEqual(['builtin', 'builtin', 'custom', 'custom', 'plugin'])
    expect(cold.models).toEqual([
      { id: 'default', label: 'Default (recommended)', description: 'Opus 5 with 1M context', resolvedModel: 'claude-opus-5[1m]', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'haiku', label: 'Haiku 4.5', description: 'Fastest', effortLevels: [] }
    ])
    expect(cold.agents).toEqual([{ name: 'Explore', description: 'Read-only search agent', model: 'sonnet' }])
    expect(cold.mcpServers).toEqual([{ name: 'playwright', status: 'connected' }])
  })

  it('folds a turn’s own advertisement in, and classifies the commands by it', async () => {
    const { fake, adapter } = adapterWith()
    await adapter.capabilities(cwd)
    await drain(adapter.send('sess-cap', 'go', { cwd }))
    const warm = await adapter.capabilities(cwd)

    // One CLI start for the whole test: the turn refreshed the lists, the cache held the rest.
    expect(fake.captured.probes).toBe(1)
    expect(warm).toMatchObject({ version: '2.0.99', model: 'claude-opus-5', permissionMode: 'acceptEdits', outputStyle: 'Concise', tools: ['Bash', 'Read'] })
    expect(warm.plugins).toEqual([{ name: 'frontend-design', version: '1.2.0', path: '/plugins/fd' }])
    // A skill is only nameable from the turn; its prose comes from the command of the same name.
    expect(warm.skills).toEqual([{ name: 'dataviz', description: 'Chart design guidance' }])
    expect(warm.commands).toEqual([
      { name: 'compact', description: 'Clear the conversation history', source: 'builtin' },
      { name: 'exit', description: 'Exit the REPL', source: 'terminal' },
      { name: 'ship', description: 'Group commits, push and open a PR', argumentHint: 'optional title', source: 'custom' },
      { name: 'dataviz', description: 'Chart design guidance', source: 'skill' },
      { name: 'frontend-design:frontend-design', description: 'Distinctive visual design', aliases: ['frontend-design'], source: 'plugin', plugin: 'frontend-design' }
    ])
  })

  it('takes the CLI at its word when a turn replaces the command list', async () => {
    const fake = fakeSdk(() =>
      (async function* () {
        yield advertisement
        yield { type: 'system', subtype: 'commands_changed', commands: [{ name: 'brand-new', description: 'discovered mid-turn (project)', argumentHint: '' }], uuid: 'u-cc', session_id: 'sess-cap' }
        yield resultMessage('sess-cap')
      })()
    )
    const adapter = new ClaudeAdapter({ loadSdk: async () => fake.module })
    await drain(adapter.send('sess-cap', 'go', { cwd }))
    const after = await adapter.capabilities(cwd)
    expect(after.commands).toEqual([{ name: 'brand-new', description: 'discovered mid-turn', source: 'custom' }])
    // The rest of the turn's advertisement survived the replacement.
    expect(after.tools).toEqual(['Bash', 'Read'])
  })

  it('flattens the configured hooks and says which settings file each came from', async () => {
    const { adapter } = adapterWith()
    expect((await adapter.capabilities(cwd)).hooks).toEqual([
      { event: 'SessionStart', kind: 'command', target: 'state.sh', source: 'user' },
      { event: 'PreToolUse', matcher: 'Write', kind: 'command', target: 'lint.sh', source: 'project' },
      { event: 'PreToolUse', matcher: 'Write', kind: 'http', target: 'https://audit.example', source: 'project' }
    ])
  })

  it('still answers when the settings cascade cannot be read', async () => {
    const { adapter } = adapterWith({
      settings: () => {
        throw new Error('managed-settings.json is unreadable')
      }
    })
    const capabilities = await adapter.capabilities(cwd)
    // One unreadable settings file must not withhold every command, model and subagent.
    expect(capabilities.hooks).toEqual([])
    expect(capabilities.commands).toHaveLength(5)
  })

  it('caches per checkout, and re-probes only when asked to', async () => {
    const { fake, adapter } = adapterWith()
    await adapter.capabilities(cwd)
    await adapter.capabilities(cwd)
    expect(fake.captured.probes).toBe(1)
    await adapter.capabilities(cwd, { refresh: true })
    expect(fake.captured.probes).toBe(2)
    await adapter.capabilities('/tmp/other')
    expect(fake.captured.probes).toBe(3)
  })
})

describe('live-turn and capability routes', () => {
  let server: TestServer
  let repo: FixtureRepo
  let worktreeId: string

  beforeEach(async () => {
    server = await createTestServer()
    repo = await createFixtureRepo()
    await repo.commit({ 'a.txt': 'one\n' }, 'init')
    const project = (await server.call('POST', routes.projects(), { path: repo.path })).body.project
    worktreeId = (await server.call('GET', routes.project(project.id))).body.worktrees[0].id
  })
  afterEach(async () => {
    await server.close()
    repo.cleanup()
  })

  it('reads what a session in this worktree can do, for the checkout the worktree points at', async () => {
    const answer = await server.call('GET', `${routes.agentCapabilities(worktreeId)}?provider=claude&session=s1&refresh=1`)
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({ provider: 'claude', cwd: repo.path, tools: ['Bash'] })
    expect(server.agent.capabilityReads).toEqual([{ cwd: repo.path, sessionId: 's1', refresh: true }])

    expect((await server.call('GET', routes.agentCapabilities(worktreeId))).status).toBe(400)

    // A provider that advertises nothing is a 404, not a 500 — the client asked a fair question.
    server.agent.capabilities = undefined
    const unsupported = await server.call('GET', `${routes.agentCapabilities(worktreeId)}?provider=claude`)
    expect(unsupported.status).toBe(404)
    expect(unsupported.body.error.code).toBe('unsupported')
  })

  it('steers the running turn, and 404s once there is none', async () => {
    expect((await server.call('POST', routes.interrupt('claude', 's1'))).status).toBe(204)
    expect((await server.call('POST', routes.queue('claude', 's1'), { text: 'and also this' })).status).toBe(204)
    expect((await server.call('PATCH', routes.liveControls('claude', 's1'), { model: 'opus', autonomy: 'full' })).status).toBe(204)

    expect(server.agent.interrupted).toEqual(['s1'])
    expect(server.agent.queued).toEqual([{ sessionId: 's1', text: 'and also this', images: undefined }])
    expect(server.agent.controls).toEqual([{ sessionId: 's1', input: { model: 'opus', autonomy: 'full' } }])

    // Nothing running under that id: the turn ended, or it belongs to another daemon.
    for (const stale of [
      await server.call('POST', routes.interrupt('claude', 'gone')),
      await server.call('POST', routes.queue('claude', 'gone'), { text: 'hello' }),
      await server.call('PATCH', routes.liveControls('claude', 'gone'), { model: 'opus' })
    ]) {
      expect(stale.status).toBe(404)
      expect(stale.body.error.code).toBe('no_live_turn')
    }

    expect((await server.call('POST', routes.queue('claude', 's1'), { text: '' })).status).toBe(400)
    expect((await server.call('PATCH', routes.liveControls('claude', 's1'), { autonomy: 'sudo' })).status).toBe(400)
  })
})

describe('claude adapter message ids', () => {
  const messageIds = (frames: AgentStreamEvent[]) => frames.flatMap((frame) => (frame.type === 'message_id' ? [frame] : []))
  const eventsById = (frames: AgentStreamEvent[]) => new Map(frames.flatMap((frame) => (frame.type === 'event' ? [[frame.event.id, frame.event] as const] : [])))

  it('names every prompt it sends, and tells the client which event carries that name', async () => {
    const sent: SDKUserMessage[] = []
    const fake = fakeSdk((_options, prompt) =>
      (async function* () {
        const prompts = prompt[Symbol.asyncIterator]()
        sent.push((await prompts.next()).value as SDKUserMessage)
        yield initMessage('sess-mid')
        // Parks on the prompt stream the way the CLI does, so a queued prompt is read as its own.
        sent.push((await prompts.next()).value as SDKUserMessage)
        yield resultMessage('sess-mid')
      })()
    )

    const adapter = new ClaudeAdapter({ loadSdk: async () => fake.module })
    const frames: AgentStreamEvent[] = []
    for await (const frame of adapter.send(null, 'first', {})) {
      frames.push(frame)
      if (frame.type === 'session') expect(adapter.queue('sess-mid', 'and also this')).toBe(true)
    }

    // Nothing is rewindable unless the turn that wrote it checkpointed as it went.
    expect(fake.captured.options?.enableFileCheckpointing).toBe(true)

    // The uuid the daemon chose is the one the CLI is handed — which is the one it stores.
    const uuids = sent.map((message) => message.uuid)
    expect(uuids.every((uuid) => typeof uuid === 'string' && uuid.length > 0)).toBe(true)
    expect(new Set(uuids).size).toBe(2)

    const ids = messageIds(frames)
    expect(ids.map((frame) => frame.messageId)).toEqual(uuids)
    // Each frame points at the echoed prompt it names, not at some other event of the turn.
    const byId = eventsById(frames)
    expect(ids.map((frame) => byId.get(frame.eventId)?.payload)).toEqual([
      expect.objectContaining({ type: 'user_message', text: 'first' }),
      expect.objectContaining({ type: 'user_message', text: 'and also this' })
    ])
  })

  it('reports the provider’s uuid for a replayed prompt, alongside the images it carried', async () => {
    const home = mkdtempSync(join(tmpdir(), 'canopy-claude-'))
    const previousHome = process.env.HOME
    process.env.HOME = home
    try {
      const fake = {
        ...fakeSdk(() => (async function* () {})()).module,
        getSessionMessages: async () => [
          { type: 'user', uuid: 'u-first', session_id: 'sess-x', message: { role: 'user', content: 'do the thing' } },
          { type: 'assistant', uuid: 'a-1', session_id: 'sess-x', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
          {
            type: 'user',
            uuid: 'u-second',
            session_id: 'sess-x',
            message: { role: 'user', content: [{ type: 'text', text: 'look at [Image #1]' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] }
          },
          // Bookkeeping the person never typed: it opens no turn, so it names nothing either.
          { type: 'user', uuid: 'u-caveat', session_id: 'sess-x', message: { role: 'user', content: '<system-reminder>ignore this</system-reminder>' } }
        ]
      } as unknown as SdkModule

      const { events, extras } = await new ClaudeAdapter({ loadSdk: async () => fake }).transcript('sess-x', '/tmp/wt-ids')
      const prompts = events.filter((event) => event.payload.type === 'user_message' && !event.payload.synthetic)
      expect(prompts).toHaveLength(2)
      expect(prompts.map((event) => extras[event.id]?.messageId)).toEqual(['u-first', 'u-second'])
      // One event, both facts: the images the mapper lifted out and the id a rewind names.
      expect(extras[prompts[1]!.id]).toEqual({ messageId: 'u-second', images: [{ label: 'Image #1', mediaType: 'image/png', data: 'AAA' }] })
      expect(Object.keys(extras)).toHaveLength(2)
    } finally {
      process.env.HOME = previousHome
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('claude adapter rewind', () => {
  const cwd = '/tmp/wt-rewind'
  // As the CLI answers (measured): the dry run names the files; the real rewind answers only that it happened.
  const fixture = (_messageId: string, options?: { dryRun?: boolean }): RewindFilesResult =>
    options?.dryRun ? { canRewind: true, filesChanged: [`${cwd}/src/a.ts`, `${cwd}/docs/b.md`, '/etc/elsewhere'], insertions: 3, deletions: 4 } : { canRewind: true }

  it('resumes the session just to ask, when no turn is running', async () => {
    const fake = fakeSdk(() => (async function* () {})(), { rewind: fixture })
    const result = await new ClaudeAdapter({ loadSdk: async () => fake.module }).rewind('sess-rw', { messageId: 'u-7', cwd })

    expect(fake.captured.queries).toHaveLength(1)
    // Resumed onto the very session whose checkpoints are being asked for, and unable to write:
    // the query exists to ask a question, not to run a turn.
    expect(fake.captured.queries[0]).toMatchObject({ resume: 'sess-rw', cwd, enableFileCheckpointing: true, permissionMode: 'plan' })
    // A dry run first, so the answer can name what the rewind then changed.
    expect(fake.captured.rewinds).toEqual([{ messageId: 'u-7', dryRun: true }, { messageId: 'u-7', dryRun: false }])
    // The SDK answers in absolute paths; the contract is relative to the checkout. A path outside
    // it has no relative form worth showing, so it is reported as it came.
    expect(result).toEqual({ source: 'checkpoint', canRewind: true, filesChanged: ['src/a.ts', 'docs/b.md', '/etc/elsewhere'], insertions: 3, deletions: 4 })
  })

  it('asks the turn that is already running rather than starting a second CLI', async () => {
    const fake = fakeSdk(
      (_options, prompt) =>
        (async function* () {
          const prompts = prompt[Symbol.asyncIterator]()
          await prompts.next()
          yield initMessage('sess-live')
          // Parks, so the turn is still live while the rewind is asked.
          await prompts.next()
          yield resultMessage('sess-live')
        })(),
      { rewind: fixture }
    )

    const adapter = new ClaudeAdapter({ loadSdk: async () => fake.module })
    let result: Awaited<ReturnType<ClaudeAdapter['rewind']>> | undefined
    for await (const frame of adapter.send('sess-live', 'go', { cwd })) {
      if (result !== undefined || payloadOf(frame)?.type !== 'user_message') continue
      result = await adapter.rewind('sess-live', { messageId: 'u-9', cwd, dryRun: true })
      // Unparks the fake CLI so the turn can end; its echo is another `user_message`, which is
      // why the rewind above is asked exactly once.
      adapter.queue('sess-live', 'stop')
    }

    // One query for the turn and none for the rewind: the live CLI already holds the checkpoints.
    expect(fake.captured.queries).toHaveLength(1)
    expect(fake.captured.rewinds).toEqual([{ messageId: 'u-9', dryRun: true }])
    expect(result).toMatchObject({ source: 'checkpoint', canRewind: true, filesChanged: ['src/a.ts', 'docs/b.md', '/etc/elsewhere'] })
  })

  it('reports a refusal as an answer, and a CLI that cannot rewind at all as one too', async () => {
    const refused = fakeSdk(() => (async function* () {})(), { rewind: () => ({ canRewind: false, error: 'no checkpoint for that message' }) })
    expect(await new ClaudeAdapter({ loadSdk: async () => refused.module }).rewind('sess-no', { messageId: 'u-0', cwd })).toEqual({
      source: 'checkpoint',
      canRewind: false,
      error: 'no checkpoint for that message',
      filesChanged: []
    })

    // No `rewindFiles` on the query at all: an older CLI, which is still a 200 the client renders.
    const old = fakeSdk(() => (async function* () {})())
    const result = await new ClaudeAdapter({ loadSdk: async () => old.module }).rewind('sess-old', { messageId: 'u-0', cwd })
    expect(result).toMatchObject({ source: 'checkpoint', canRewind: false, filesChanged: [] })
    expect(result.error).toContain('does not support rewinding files')
  })

  it('turns a CLI that threw into a refusal rather than a failed request', async () => {
    const fake = fakeSdk(() => (async function* () {})(), {
      rewind: () => {
        throw new Error('the session file is gone')
      }
    })
    const result = await new ClaudeAdapter({ loadSdk: async () => fake.module }).rewind('sess-boom', { messageId: 'u-1', cwd })
    expect(result).toEqual({ source: 'checkpoint', canRewind: false, error: 'claude: the session file is gone', filesChanged: [] })
  })
})
