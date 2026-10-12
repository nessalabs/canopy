/**
 * The in-app terminal's shells: one pseudo-terminal per terminal, started in a worktree with its
 * environment, kept running while no window shows it.
 *
 * A socket attaches to a terminal rather than owning it — a reload, a second window or the panel
 * closing and opening again finds the same shell, and is handed its recent output first so the
 * screen comes back as it was. A shell ends when it exits or the terminal is closed, and every
 * shell ends with the daemon.
 */
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'

import type { CreateTerminalInput, TerminalInfo, TerminalServerMessage } from '@canopy/shared'

import { notFound } from '../lib/errors'

/** The part of node-pty's `IPty` the service uses, so a test can stand in for a real shell. */
export interface Pty {
  onData(listener: (data: string) => void): unknown
  onExit(listener: (event: { exitCode: number }) => void): unknown
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

export type PtySpawn = (shell: string, args: string[], options: { cwd: string; env: Record<string, string>; cols: number; rows: number }) => Pty

export interface TerminalsDeps {
  spawn: PtySpawn
  worktreePath: (worktreeId: string) => string
  /** The worktree's own variables (ports, database URLs, canopy.yaml env), layered over the daemon's. */
  worktreeEnv?: (worktreeId: string) => Record<string, string>
  /** The shell to run; the daemon's `$SHELL` by default. */
  shell?: string
  now?: () => Date
}

/** How much recent output a terminal keeps for a socket that attaches later. */
const SCROLLBACK_CHARS = 256 * 1024

type Listener = (message: TerminalServerMessage) => void

interface Terminal {
  info: TerminalInfo
  pty: Pty
  scrollback: string
  listeners: Set<Listener>
}

/** The newest `limit` characters of the output, cut at a line start so the replay begins cleanly. */
export function keepRecent(text: string, limit = SCROLLBACK_CHARS): string {
  if (text.length <= limit) return text
  const cut = text.length - limit
  const line = text.indexOf('\n', cut)
  return text.slice(line === -1 ? cut : line + 1)
}

export class TerminalsService {
  private readonly terminals = new Map<string, Terminal>()

  constructor(private readonly deps: TerminalsDeps) {}

  list(worktreeId: string): TerminalInfo[] {
    return [...this.terminals.values()].filter((t) => t.info.worktreeId === worktreeId).map((t) => t.info)
  }

  create(worktreeId: string, { cols = 80, rows = 24 }: CreateTerminalInput): TerminalInfo {
    const cwd = this.deps.worktreePath(worktreeId)
    const shell = this.deps.shell ?? process.env.SHELL ?? '/bin/bash'
    const env = {
      ...(process.env as Record<string, string>),
      ...this.deps.worktreeEnv?.(worktreeId),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'canopy'
    }
    // A login shell reads the profile that puts Homebrew and friends on PATH, which a daemon
    // started by the desktop app does not inherit.
    const pty = this.deps.spawn(shell, ['-l'], { cwd, env, cols, rows })
    const info: TerminalInfo = { id: randomUUID(), worktreeId, title: basename(shell), cwd, exitCode: null, createdAt: (this.deps.now?.() ?? new Date()).toISOString() }
    const terminal: Terminal = { info, pty, scrollback: '', listeners: new Set() }
    pty.onData((data) => {
      terminal.scrollback = keepRecent(terminal.scrollback + data)
      for (const listener of terminal.listeners) listener({ type: 'output', data })
    })
    pty.onExit(({ exitCode }) => {
      terminal.info = { ...terminal.info, exitCode }
      for (const listener of terminal.listeners) listener({ type: 'exit', code: exitCode })
    })
    this.terminals.set(info.id, terminal)
    return info
  }

  private get(terminalId: string): Terminal {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) throw notFound('terminal', terminalId)
    return terminal
  }

  /**
   * Starts sending the terminal's output to `listener`, beginning with what it already printed
   * (and its exit, when it has exited). The returned function stops it; the shell keeps running.
   */
  attach(terminalId: string, listener: Listener): () => void {
    const terminal = this.get(terminalId)
    if (terminal.scrollback) listener({ type: 'output', data: terminal.scrollback })
    if (terminal.info.exitCode !== null) listener({ type: 'exit', code: terminal.info.exitCode })
    terminal.listeners.add(listener)
    return () => terminal.listeners.delete(listener)
  }

  write(terminalId: string, data: string): void {
    const terminal = this.get(terminalId)
    if (terminal.info.exitCode === null) terminal.pty.write(data)
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const terminal = this.get(terminalId)
    if (terminal.info.exitCode === null) terminal.pty.resize(cols, rows)
  }

  close(terminalId: string): void {
    const terminal = this.get(terminalId)
    this.terminals.delete(terminalId)
    terminal.listeners.clear()
    if (terminal.info.exitCode === null) terminal.pty.kill()
  }

  /** Every shell ends with the daemon. */
  closeAll(): void {
    for (const id of [...this.terminals.keys()]) this.close(id)
  }
}
