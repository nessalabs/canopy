import { z } from 'zod'

/**
 * A shell the daemon runs for a worktree, in a pseudo-terminal, for the in-app terminal. It
 * outlives the socket that shows it: a reload, or the panel closing, reattaches to the same shell.
 */
export const TerminalInfo = z.object({
  id: z.string(),
  worktreeId: z.string(),
  /** The shell's name, as the tab shows it until something better is known. */
  title: z.string(),
  cwd: z.string(),
  /** Set once the shell exits; its output is still there to read until the terminal is closed. */
  exitCode: z.number().int().nullable(),
  createdAt: z.string()
})
export type TerminalInfo = z.infer<typeof TerminalInfo>

export const CreateTerminalInput = z.object({
  cols: z.number().int().min(2).max(1000).default(80),
  rows: z.number().int().min(2).max(500).default(24)
})
export type CreateTerminalInput = z.input<typeof CreateTerminalInput>

/** What the browser sends on a terminal's socket: keystrokes, and the size it is drawn at. */
export const TerminalClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string() }),
  z.object({ type: z.literal('resize'), cols: z.number().int().min(2).max(1000), rows: z.number().int().min(2).max(500) })
])
export type TerminalClientMessage = z.infer<typeof TerminalClientMessage>

/** What the daemon sends back: the shell's output (its recent past first, on attach), and its exit. */
export type TerminalServerMessage = { type: 'output'; data: string } | { type: 'exit'; code: number }
