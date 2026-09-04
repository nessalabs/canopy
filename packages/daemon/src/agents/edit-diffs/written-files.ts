/**
 * Which files a tool call names as its write targets, per provider. Edit tools say so in
 * their input; shell commands are parsed. Used to tag transcript items and to decide whether
 * a snapshotted change is attributable to the call that was running.
 */
import { shellWriteTargets } from './shell-writes'

/** Claude Code's file-writing tools and the argument that names the file. */
const CLAUDE_WRITE_TOOLS: Record<string, string> = { Edit: 'file_path', MultiEdit: 'file_path', Write: 'file_path', NotebookEdit: 'notebook_path' }

/** Absolute paths a Claude Code tool call wrote: the named file for edit tools, parsed targets for Bash. */
export function claudeWrittenFiles(tool: string | undefined, input: unknown, cwd?: string): string[] {
  const record = (input ?? {}) as Record<string, unknown>
  if (tool === 'Bash') return typeof record.command === 'string' ? shellWriteTargets(record.command, cwd) : []
  const path = tool ? record[CLAUDE_WRITE_TOOLS[tool] ?? ''] : undefined
  return typeof path === 'string' ? [path] : []
}

/** Paths of a Codex `fileChange` item's `changes: [{ path, kind }]`. */
export function codexChangedPaths(changes: unknown): string[] {
  if (!Array.isArray(changes)) return []
  return changes.map((change) => (change as { path?: unknown }).path).filter((path): path is string => typeof path === 'string')
}
