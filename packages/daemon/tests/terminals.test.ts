import { describe, expect, it } from 'vitest'

import type { TerminalServerMessage } from '@canopy/shared'

import { TerminalsService, keepRecent, type Pty, type PtySpawn } from '../src/terminals/service'

/** A shell that records what it is told and prints or exits when the test says so. */
function fakeShell() {
  const shells: Array<{ args: Parameters<PtySpawn>; written: string[]; sizes: number[][]; killed: boolean; print: (data: string) => void; exit: (code: number) => void }> = []
  const spawn: PtySpawn = (...args) => {
    let onData: (data: string) => void = () => undefined
    let onExit: (event: { exitCode: number }) => void = () => undefined
    const shell = { args, written: [] as string[], sizes: [] as number[][], killed: false, print: (data: string) => onData(data), exit: (code: number) => onExit({ exitCode: code }) }
    shells.push(shell)
    const pty: Pty = {
      onData: (listener) => (onData = listener),
      onExit: (listener) => (onExit = listener),
      write: (data) => shell.written.push(data),
      resize: (cols, rows) => shell.sizes.push([cols, rows]),
      kill: () => (shell.killed = true)
    }
    return pty
  }
  return { shells, spawn }
}

const service = (spawn: PtySpawn) =>
  new TerminalsService({ spawn, worktreePath: (id) => `/worktrees/${id}`, worktreeEnv: () => ({ PORT: '4100' }), shell: '/bin/zsh' })

describe('TerminalsService', () => {
  it('starts a login shell in the worktree, with its environment', () => {
    const { shells, spawn } = fakeShell()
    const info = service(spawn).create('w1', { cols: 120, rows: 30 })
    const [shell, args, options] = shells[0]!.args
    expect([shell, args, options.cwd, options.cols, options.rows]).toEqual(['/bin/zsh', ['-l'], '/worktrees/w1', 120, 30])
    expect(options.env).toMatchObject({ PORT: '4100', TERM: 'xterm-256color' })
    expect(info).toMatchObject({ worktreeId: 'w1', title: 'zsh', cwd: '/worktrees/w1', exitCode: null })
  })

  it('replays what the shell printed to a socket that attaches later, then streams', () => {
    const { shells, spawn } = fakeShell()
    const terminals = service(spawn)
    const { id } = terminals.create('w1', {})
    shells[0]!.print('$ ')
    const seen: TerminalServerMessage[] = []
    const detach = terminals.attach(id, (message) => seen.push(message))
    shells[0]!.print('ls\r\n')
    detach()
    shells[0]!.print('after\r\n')
    expect(seen).toEqual([
      { type: 'output', data: '$ ' },
      { type: 'output', data: 'ls\r\n' }
    ])
  })

  it('passes keystrokes and sizes to the shell, and stops once it has exited', () => {
    const { shells, spawn } = fakeShell()
    const terminals = service(spawn)
    const { id } = terminals.create('w1', {})
    terminals.write(id, 'echo hi\r')
    terminals.resize(id, 100, 40)
    shells[0]!.exit(0)
    terminals.write(id, 'ignored')
    expect(shells[0]!.written).toEqual(['echo hi\r'])
    expect(shells[0]!.sizes).toEqual([[100, 40]])
    expect(terminals.list('w1')[0]!.exitCode).toBe(0)
  })

  it('tells a late socket the shell already exited', () => {
    const { shells, spawn } = fakeShell()
    const terminals = service(spawn)
    const { id } = terminals.create('w1', {})
    shells[0]!.exit(130)
    const seen: TerminalServerMessage[] = []
    terminals.attach(id, (message) => seen.push(message))
    expect(seen).toEqual([{ type: 'exit', code: 130 }])
  })

  it('kills the shell on close and forgets the terminal', () => {
    const { shells, spawn } = fakeShell()
    const terminals = service(spawn)
    const { id } = terminals.create('w1', {})
    terminals.create('w2', {})
    terminals.close(id)
    expect(shells[0]!.killed).toBe(true)
    expect(terminals.list('w1')).toEqual([])
    expect(terminals.list('w2')).toHaveLength(1)
    expect(() => terminals.attach(id, () => undefined)).toThrow()
  })
})

describe('keepRecent', () => {
  it('keeps the newest output from a line start', () => {
    expect(keepRecent('old line\nnew line\n', 12)).toBe('new line\n')
    expect(keepRecent('short', 12)).toBe('short')
  })
})
