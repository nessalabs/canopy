/**
 * "Undo what that turn wrote", by Claude Code's own file checkpoints.
 *
 * The CLI keeps a checkpoint per user message when a turn runs with `enableFileCheckpointing`, and
 * writes them into the session file — so a rewind can be asked of the query that is running the
 * turn *or*, long after it ended, of a fresh query resumed onto the same session. Both are the same
 * call; only who is holding the CLI differs.
 *
 * What it covers is what the CLI's file tools wrote: Write, Edit, MultiEdit, NotebookEdit. A file a
 * Bash command created or deleted is not checkpointed and stays exactly as the turn left it — which
 * is why `RewindInput` also takes a `tree`, and Canopy's own hook snapshots answer that one.
 */
import { isAbsolute, relative } from 'node:path'

import type { RewindInput, RewindResult } from '@canopy/shared'

import type { SdkModule } from './claude'
import type { LiveQuery, LiveTurn, RewindFilesResult } from './claude-live'

/**
 * A CLI that has not answered by now is wedged, not slow — and a rewind holds an HTTP request open
 * while it waits, so it is given a shorter leash than a turn would get.
 */
const TIMEOUT_MS = 30_000

/**
 * Asks whoever is holding this session's checkpoints to put the files back.
 *
 * A refusal is a result, not a throw: the CLI answers "no, and here is why" for a message it has no
 * checkpoint for (a turn that ran before checkpointing was on, a session whose history was
 * compacted away), and the route reports that as a 200 the client can render.
 */
export async function rewindClaudeFiles(module: SdkModule, turn: LiveTurn | undefined, sessionId: string, input: RewindInput): Promise<RewindResult> {
  try {
    const result = turn
      ? await previewThenRewind(input, (dryRun) => turn.rewindFiles(input.messageId, dryRun))
      : await onResumedQuery(module, sessionId, input, (rewind) => previewThenRewind(input, rewind))
    return toRewindResult(result, input.cwd)
  } catch (error) {
    return { source: 'checkpoint', canRewind: false, error: `claude: ${error instanceof Error ? error.message : String(error)}`, filesChanged: [] }
  }
}

/**
 * A real rewind answers with `canRewind` and little else — the file list and line counts come only
 * from a dry run (measured on 0.3.260). So a real rewind is a dry run first, whose answer names what
 * the rewind then changes; a dry run that refuses is the whole answer.
 */
async function previewThenRewind(input: RewindInput, rewind: (dryRun: boolean) => Promise<RewindFilesResult>): Promise<RewindFilesResult> {
  const preview = await rewind(true)
  if (input.dryRun === true || !preview.canRewind) return preview
  const applied = await rewind(false)
  return {
    ...applied,
    filesChanged: applied.filesChanged ?? preview.filesChanged,
    insertions: applied.insertions ?? preview.insertions,
    deletions: applied.deletions ?? preview.deletions
  }
}

/**
 * Starts a CLI onto the session just to ask it, then shuts it down. The prompt generator parks on a
 * gate released in the `finally`, so the query has a prompt stream that never produces a message and
 * therefore never runs a turn — the same trick the capability probe uses. `plan` mode is belt and
 * braces on top of that: even a CLI that somehow decided to act could not write anything.
 *
 * The iterator is deliberately never touched. Draining the query closes its transport, and the
 * control channel — which is where `rewindFiles` lives — goes with it.
 */
async function onResumedQuery(
  module: SdkModule,
  sessionId: string,
  input: RewindInput,
  ask: (rewind: (dryRun: boolean) => Promise<RewindFilesResult>) => Promise<RewindFilesResult>
): Promise<RewindFilesResult> {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => (release = resolve))
  async function* idle(): AsyncGenerator<never> {
    await gate
  }

  const query = module.query({
    prompt: idle(),
    options: { resume: sessionId, cwd: input.cwd, enableFileCheckpointing: true, permissionMode: 'plan' }
  })
  try {
    const answer = (async (): Promise<RewindFilesResult> => {
      // The CLI is not listening on its control channel until it has initialized.
      await query.initializationResult()
      const rewindFiles = (query as unknown as LiveQuery).rewindFiles
      if (!rewindFiles) return { canRewind: false, error: 'this Claude Code version does not support rewinding files' }
      return ask((dryRun) => rewindFiles.call(query, input.messageId, { dryRun }))
    })()
    return await Promise.race([answer, timeout()])
  } finally {
    release?.()
    // Releasing the gate ends the prompt stream; returning closes the query and the CLI with it.
    await Promise.resolve(query.return(undefined)).catch(() => undefined)
  }
}

function timeout(): Promise<never> {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the rewind did not answer within ${TIMEOUT_MS}ms`)), TIMEOUT_MS)
    timer.unref?.()
  })
}

/**
 * The SDK reports absolute paths; the contract is paths relative to the checkout, because that is
 * what every other file list Canopy ships is and what the UI matches its diff rows against.
 */
function toRewindResult(result: RewindFilesResult, cwd: string): RewindResult {
  return {
    source: 'checkpoint',
    canRewind: result.canRewind,
    ...(result.error ? { error: result.error } : {}),
    filesChanged: (result.filesChanged ?? []).map((path) => relativeTo(cwd, path)),
    ...(typeof result.insertions === 'number' ? { insertions: result.insertions } : {}),
    ...(typeof result.deletions === 'number' ? { deletions: result.deletions } : {})
  }
}

/** A path outside the checkout has no relative form worth showing, so it is reported as it came. */
function relativeTo(cwd: string, path: string): string {
  if (!isAbsolute(path)) return path
  const rel = relative(cwd, path)
  return rel === '' || rel.startsWith('..') ? path : rel
}
