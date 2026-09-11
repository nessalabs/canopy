import type { PermissionMode, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

/**
 * The turns that are running right now, and the handles that steer them.
 *
 * Every Claude turn runs in the SDK's *streaming-input* mode, which is the only mode where the
 * control channel exists: interrupting, retuning the model or the permission mode mid-flight, and
 * pushing a second prompt into a turn already in progress all require it. Those requests arrive on
 * their own HTTP calls, not on the turn's SSE stream, so — exactly like the permission desk — the
 * turn parks a handle here under its session id and the routes find it by that id alone.
 */

/** The prompt side of a live turn: the async generator the SDK pulls user messages from. */
export class PromptChannel {
  private readonly pending: SDKUserMessage[] = []
  private wake: (() => void) | undefined
  private closed = false

  /** Hands the SDK another user message while the turn runs. Ignored once the turn has ended. */
  push(message: SDKUserMessage): void {
    if (this.closed) return
    this.pending.push(message)
    this.wake?.()
  }

  /**
   * Ends the stream of prompts. The SDK holds the query open for as long as this generator has not
   * returned, so a turn that forgets to close leaks the CLI process behind it.
   */
  close(): void {
    this.closed = true
    this.wake?.()
  }

  /** The turn's prompt: its opening message, then whatever is pushed until the turn ends. */
  async *stream(first: SDKUserMessage): AsyncGenerator<SDKUserMessage> {
    yield first
    while (!this.closed) {
      while (this.pending.length > 0) yield this.pending.shift() as SDKUserMessage
      if (this.closed) break
      await new Promise<void>((resolve) => (this.wake = resolve))
      this.wake = undefined
    }
  }
}

/**
 * What `query.rewindFiles` answers — the SDK's own `RewindFilesResult`, restated here so the
 * daemon and its tests can name it without importing the SDK. `filesChanged` is absolute paths.
 */
export interface RewindFilesResult {
  canRewind: boolean
  error?: string
  filesChanged?: string[]
  insertions?: number
  deletions?: number
}

/** What the SDK's `Query` offers a running turn; narrowed so tests can script it. */
export interface LiveQuery {
  interrupt?(): Promise<unknown>
  setModel?(model?: string): Promise<void>
  setPermissionMode?(mode: PermissionMode): Promise<void>
  rewindFiles?(userMessageId: string, options?: { dryRun?: boolean }): Promise<RewindFilesResult>
}

export interface LiveTurn {
  /** Folds another user message into the running turn. */
  push(message: SDKUserMessage): void
  /** Stops the turn the way Esc does in a terminal; the turn still emits its own `result`. */
  interrupt(): Promise<void>
  setModel(model: string): Promise<void>
  setPermissionMode(mode: PermissionMode): Promise<void>
  /**
   * Puts the files back to how they were before `messageId` was answered, from the CLI's own
   * checkpoints — only what its file tools wrote, never a Bash side effect. The live query is the
   * cheapest place to ask: the CLI is already up and holding this session's checkpoints.
   */
  rewindFiles(messageId: string, dryRun?: boolean): Promise<RewindFilesResult>
}

export interface LiveTurnOptions {
  /** Also called with each pushed message, so the queued prompt shows up in the turn's stream. */
  onPush?: (message: SDKUserMessage) => void
}

/**
 * A control request is best-effort: the turn may be one message from its `result` when it arrives,
 * and a CLI that has already exited rejects. Losing the request is the correct outcome — the caller
 * only promised the turn *was* running, which it was.
 */
const swallow = async (work: Promise<unknown> | undefined): Promise<void> => {
  try {
    await work
  } catch {
    // the turn ended under us
  }
}

export function createLiveTurn(query: LiveQuery, channel: PromptChannel, options: LiveTurnOptions = {}): LiveTurn {
  return {
    push(message) {
      channel.push(message)
      options.onPush?.(message)
    },
    interrupt: () => swallow(query.interrupt?.()),
    setModel: (model) => swallow(query.setModel?.(model)),
    setPermissionMode: (mode) => swallow(query.setPermissionMode?.(mode)),
    // Unlike the other three this one has an answer to carry back, so a CLI too old to offer it
    // says so rather than being swallowed into a silent no-op.
    rewindFiles: async (messageId, dryRun) =>
      query.rewindFiles
        ? query.rewindFiles(messageId, { dryRun: dryRun === true })
        : { canRewind: false, error: 'this Claude Code version does not support rewinding files' }
  }
}

/**
 * One per adapter. A resumed turn is keyed by its session id from the start; a *fresh* session has
 * no id until the SDK's `init` message names it, so it registers under a throwaway key and re-keys
 * then — by which point the client has learned the same id from the stream's `session` frame and
 * can address it.
 */
export class LiveTurns {
  private readonly turns = new Map<string, LiveTurn>()

  register(key: string, turn: LiveTurn): void {
    this.turns.set(key, turn)
  }

  rekey(oldKey: string, sessionId: string): void {
    if (oldKey === sessionId) return
    const turn = this.turns.get(oldKey)
    if (!turn) return
    this.turns.delete(oldKey)
    this.turns.set(sessionId, turn)
  }

  get(sessionId: string): LiveTurn | undefined {
    return this.turns.get(sessionId)
  }

  /**
   * Forgets a finished turn — but never someone else's: a second turn on the same session can be
   * registered before the first one's `finally` runs, and dropping *that* would strand it.
   */
  release(key: string, turn?: LiveTurn): void {
    if (turn && this.turns.get(key) !== turn) return
    this.turns.delete(key)
  }
}
