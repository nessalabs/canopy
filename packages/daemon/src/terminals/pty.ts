import { spawn } from 'node-pty'

import type { PtySpawn } from './service'

/** A real shell in a pseudo-terminal, through node-pty. */
export const spawnPty: PtySpawn = (shell, args, { cwd, env, cols, rows }) => spawn(shell, args, { name: 'xterm-256color', cwd, env, cols, rows })
